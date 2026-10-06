"""Python signer x Solidity contract on a local anvil chain (--network monad).

Skipped when anvil or the compiled contract is unavailable."""

import secrets
import time

import pytest

from counterproof import devchain
from counterproof.signer import sign_attestation

pytestmark = pytest.mark.skipif(not devchain.ARTIFACT.exists(), reason="contract not built (forge build)")

K = devchain.ANVIL_KEYS


@pytest.fixture(scope="module")
def chain():
    try:
        devchain.anvil_exe()
    except FileNotFoundError:
        pytest.skip("anvil not installed")
    with devchain.Anvil() as a:
        w3 = devchain.web3_for(a.url)
        addr = devchain.deploy(w3)
        yield w3, devchain.contract_at(w3, addr), addr


def b32() -> str:
    return "0x" + secrets.token_hex(32)


def setup_challenge(w3, c, reward=10**15):
    now = w3.eth.get_block("latest").timestamp
    spec = b32()
    evaluator = devchain.address_of(K["evaluator"])
    r = devchain.send(w3, K["publisher"], c.functions.createChallenge(bytes.fromhex(spec[2:]), evaluator, now + 600, now + 1200), value=reward)
    assert r.status == 1
    cid = c.events.ChallengeCreated().process_receipt(r)[0]["args"]["challengeId"]
    cand = b32()
    recipient = devchain.address_of(K["challenger"])
    r = devchain.send(w3, K["challenger"], c.functions.commitSubmission(cid, bytes.fromhex(cand[2:]), recipient))
    assert r.status == 1
    sid = "0x" + bytes(c.events.SubmissionCommitted().process_receipt(r)[0]["args"]["submissionId"]).hex()
    msg = {"challengeId": cid, "specDigest": spec, "submissionId": sid, "candidateDigest": cand, "evidenceDigest": b32(),
           "challenger": recipient.lower(), "recipient": recipient.lower(), "verdict": 1, "expiry": now + 900}
    return cid, msg


def as_tuple(w3, m):
    return (m["challengeId"], bytes.fromhex(m["specDigest"][2:]), bytes.fromhex(m["submissionId"][2:]),
            bytes.fromhex(m["candidateDigest"][2:]), bytes.fromhex(m["evidenceDigest"][2:]),
            w3.to_checksum_address(m["challenger"]), w3.to_checksum_address(m["recipient"]), m["verdict"], m["expiry"])


def settle(w3, c, msg, sig, key=None):
    return devchain.send(w3, key or K["relayer"], c.functions.settle(as_tuple(w3, msg), bytes.fromhex(sig[2:])))


def revert_reason(w3, c, msg, sig) -> str:
    try:
        c.functions.settle(as_tuple(w3, msg), bytes.fromhex(sig[2:])).call({"from": devchain.address_of(K["relayer"])})
    except Exception as e:  # web3 raises ContractCustomError carrying the selector
        return str(e)
    return ""


def selector(c, name: str) -> str:
    from eth_utils import keccak

    abi = next(x for x in c.abi if x["type"] == "error" and x["name"] == name)
    sig = f"{name}({','.join(i['type'] for i in abi['inputs'])})"
    return "0x" + keccak(text=sig)[:4].hex()


def test_python_typed_data_hash_matches_contract(chain):
    from eth_account.messages import encode_typed_data
    from eth_utils import keccak

    from counterproof.signer import ATTESTATION_TYPES, domain

    w3, c, addr = chain
    _, msg = setup_challenge(w3, c)
    data = dict(msg)
    for k in ("specDigest", "submissionId", "candidateDigest", "evidenceDigest"):
        data[k] = bytes.fromhex(data[k][2:])
    for k in ("challenger", "recipient"):
        data[k] = w3.to_checksum_address(data[k])
    enc = encode_typed_data(domain_data=domain(w3.eth.chain_id, addr), message_types=ATTESTATION_TYPES, message_data=data)
    py_hash = keccak(b"\x19\x01" + enc.header + enc.body)
    assert py_hash == bytes(c.functions.hashAttestation(as_tuple(w3, msg)).call())


def test_valid_attestation_settles_to_the_bound_recipient_even_when_relayed(chain):
    w3, c, addr = chain
    cid, msg = setup_challenge(w3, c, reward=12345)
    sig, _ = sign_attestation(K["evaluator"], w3.eth.chain_id, addr, msg)
    relayer = devchain.address_of(K["relayer"])
    before = c.functions.credits(relayer).call()
    r = settle(w3, c, msg, sig)
    assert r.status == 1
    assert c.functions.credits(w3.to_checksum_address(msg["recipient"])).call() >= 12345
    assert c.functions.credits(relayer).call() == before
    # the same attestation cannot settle twice
    assert settle(w3, c, msg, sig).status == 0
    assert selector(c, "AlreadySettled") in revert_reason(w3, c, msg, sig)


def test_wrong_signer_is_rejected(chain):
    w3, c, addr = chain
    _, msg = setup_challenge(w3, c)
    sig, _ = sign_attestation(K["outsider"], w3.eth.chain_id, addr, msg)
    assert settle(w3, c, msg, sig).status == 0
    assert selector(c, "SignerNotEvaluator") in revert_reason(w3, c, msg, sig)


def test_altered_recipient_is_rejected(chain):
    w3, c, addr = chain
    _, msg = setup_challenge(w3, c)
    thief = devchain.address_of(K["outsider"]).lower()
    forged = dict(msg, recipient=thief)
    sig, _ = sign_attestation(K["evaluator"], w3.eth.chain_id, addr, forged)  # even a valid evaluator signature
    assert settle(w3, c, forged, sig).status == 0
    good_sig, _ = sign_attestation(K["evaluator"], w3.eth.chain_id, addr, msg)
    assert settle(w3, c, forged, good_sig).status == 0  # signature over the real recipient, tuple altered


def test_cross_chain_and_cross_contract_signatures_are_rejected(chain):
    w3, c, addr = chain
    _, msg = setup_challenge(w3, c)
    other_chain, _ = sign_attestation(K["evaluator"], 10143, addr, msg)
    assert settle(w3, c, msg, other_chain).status == 0
    other_contract = devchain.deploy(w3)
    other_addr_sig, _ = sign_attestation(K["evaluator"], w3.eth.chain_id, other_contract, msg)
    assert settle(w3, c, msg, other_addr_sig).status == 0
    good, _ = sign_attestation(K["evaluator"], w3.eth.chain_id, addr, msg)
    assert settle(w3, c, msg, good).status == 1


def test_refund_only_after_the_settlement_window(chain):
    w3, c, addr = chain
    cid, msg = setup_challenge(w3, c, reward=777)
    assert devchain.send(w3, K["outsider"], c.functions.refund(cid)).status == 0
    w3.provider.make_request("evm_increaseTime", [1300])
    w3.provider.make_request("evm_mine", [])
    sig, _ = sign_attestation(K["evaluator"], w3.eth.chain_id, addr, msg)
    assert settle(w3, c, msg, sig).status == 0  # window closed (and attestation expired)
    publisher = devchain.address_of(K["publisher"])
    before = c.functions.credits(publisher).call()
    assert devchain.send(w3, K["outsider"], c.functions.refund(cid)).status == 1
    assert c.functions.credits(publisher).call() == before + 777
    assert devchain.send(w3, K["outsider"], c.functions.refund(cid)).status == 0


def test_dev_keys_refuse_non_local_chains():
    class Fake:
        class eth:
            chain_id = 10143

    with pytest.raises(RuntimeError):
        devchain.require_local(Fake())
