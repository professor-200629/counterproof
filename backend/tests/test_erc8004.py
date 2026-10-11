"""ERC-8004 link: registration and feedback files (offline), and the real official registries on a
local anvil fork of Monad testnet (COUNTERPROOF_FORK_TESTS=1; needs network access).

The fork runs with chain id 31337 so the public anvil dev keys stay local-only
(devchain.require_local); the registry addresses for 31337 are pointed at the forked copies
of the official Monad testnet registries.
"""

import os
import socket
import subprocess
import time

import pytest
from conftest import BUDGET_ATTACK, make_candidate
from web3.logs import DISCARD

from counterproof import devchain, erc8004
from counterproof.canonical import canonical_json, to_bytes32
from counterproof.evaluator import evaluate

K = devchain.ANVIL_KEYS
DIGEST = "sha256:" + "ab" * 32


# ----------------------------------------------------------------------------- offline
def test_registration_round_trips_through_a_data_uri():
    reg = erc8004.registration_file(target_key="ref-purchasing-agent@1.0.0", artifact_digest=DIGEST,
                                    name="Ref agent", description="fixture", web_url="https://example.test/")
    uri = erc8004.data_uri(reg)
    assert uri.startswith("data:application/json;base64,")
    back = erc8004.parse_data_uri(uri)
    assert back == reg
    assert erc8004.declared_target(back) == ("ref-purchasing-agent@1.0.0", DIGEST)


@pytest.mark.parametrize("uri", ["https://example.test/agent.json", "data:text/plain;base64,aGk=",
                                 "data:application/json;base64,!!!", "data:application/json;base64," + "A" * 20000])
def test_unsupported_or_malformed_agent_uris_fail_closed(uri):
    with pytest.raises(erc8004.Erc8004Error):
        erc8004.parse_data_uri(uri)


def test_a_registration_without_a_counterproof_declaration_is_refused():
    with pytest.raises(erc8004.Erc8004Error):
        erc8004.declared_target({"type": erc8004.REGISTRATION_TYPE, "name": "x"})
    with pytest.raises(erc8004.Erc8004Error):
        erc8004.declared_target({"type": "something-else", "counterproof": {"target": "a", "artifactDigest": "b"}})


def test_feedback_hash_is_keccak_of_the_canonical_file():
    f = erc8004.violation_feedback_file(chain_id=10143, agent_id=7, reporter="0x" + "11" * 20, bounties="0x" + "22" * 20,
                                        onchain_id=3, spec_digest=DIGEST, target_key="t@1", artifact_digest=DIGEST,
                                        rule_id="R1", submission_id="0x" + "33" * 32, evidence_digest=DIGEST,
                                        settle_tx="0x" + "44" * 32, endpoint=None, created_at=0)
    args, uri = erc8004.give_feedback_args(f)
    assert args[0] == 7 and args[1] == 1 and args[2] == 0
    assert args[3] == erc8004.TAG_VIOLATION and args[4] == "R1"
    assert "0x" + args[7].hex() == erc8004.keccak_hex(canonical_json(f))
    assert erc8004.parse_data_uri(uri) == f
    assert f["agentRegistry"] == "eip155:10143:" + erc8004.REGISTRIES[10143]["identity"]


def test_unknown_chains_have_no_registries():
    with pytest.raises(erc8004.Erc8004Error):
        erc8004.registries(1)


# ----------------------------------------------------------------------------- fork of Monad testnet
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def fork():
    if os.environ.get("COUNTERPROOF_FORK_TESTS") != "1":
        pytest.skip("set COUNTERPROOF_FORK_TESTS=1 to run against a fork of Monad testnet (needs network)")
    if not devchain.ARTIFACT.exists():
        pytest.skip("contract not built")
    port = _free_port()
    proc = subprocess.Popen([devchain.anvil_exe(), "--fork-url", "https://testnet-rpc.monad.xyz", "--network", "monad",
                             "--chain-id", str(devchain.ANVIL_CHAIN_ID), "--port", str(port), "--silent"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        w3 = devchain.web3_for(f"http://127.0.0.1:{port}")
        deadline = time.monotonic() + 60
        while not w3.is_connected():
            if time.monotonic() > deadline or proc.poll() is not None:
                pytest.skip("anvil fork of Monad testnet did not start")
            time.sleep(0.5)
        # The public anvil dev addresses carry EIP-7702 delegations on Monad testnet; the registry's
        # safe mint calls into them and reverts. Clear that code on the fork.
        for key in K.values():
            w3.provider.make_request("anvil_setCode", [devchain.address_of(key), "0x"])
        erc8004.REGISTRIES[devchain.ANVIL_CHAIN_ID] = erc8004.REGISTRIES[10143]
        assert len(w3.eth.get_code(w3.to_checksum_address(erc8004.REGISTRIES[10143]["reputation"]))) > 0
        addr = devchain.deploy(w3)
        yield w3, devchain.contract_at(w3, addr)
    finally:
        erc8004.REGISTRIES.pop(devchain.ANVIL_CHAIN_ID, None)
        proc.kill()
        proc.wait(timeout=10)


def _register(w3, key, digest, target="ref-purchasing-agent@1.0.0") -> int:
    reg = erc8004.registration_file(target_key=target, artifact_digest=digest, name="Ref agent", description="fixture")
    r = devchain.send(w3, key, erc8004.identity(w3).functions.register(erc8004.data_uri(reg)))
    assert r.status == 1
    return erc8004.registered_agent_id(w3, r)


def _settled_violation(w3, c, spec_v1):
    """A real verified-violation bundle, funded, committed, attested and settled on the fork."""
    from counterproof.signer import sign_attestation

    spec, d = spec_v1
    cand = make_candidate(d, BUDGET_ATTACK, "R1")
    bundle = evaluate(spec=spec, spec_dgst=d, candidate=cand, submission={})
    assert bundle["verdict"]["outcome"] == "verified_violation"
    now = w3.eth.get_block("latest").timestamp
    evaluator = devchain.address_of(K["evaluator"])
    r = devchain.send(w3, K["publisher"], c.functions.createChallenge(bytes.fromhex(to_bytes32(d)[2:]), evaluator,
                                                                        now + 600, now + 1200), value=1000)
    cid = c.events.ChallengeCreated().process_receipt(r)[0]["args"]["challengeId"]
    recipient = devchain.address_of(K["challenger"])
    cand_digest = "0x" + "5a" * 32
    r = devchain.send(w3, K["challenger"], c.functions.commitSubmission(cid, bytes.fromhex(cand_digest[2:]), recipient))
    sid = "0x" + bytes(c.events.SubmissionCommitted().process_receipt(r)[0]["args"]["submissionId"]).hex()
    msg = {"challengeId": cid, "specDigest": to_bytes32(d), "submissionId": sid, "candidateDigest": cand_digest,
           "evidenceDigest": to_bytes32(bundle["evidence_digest"]), "challenger": recipient.lower(),
           "recipient": recipient.lower(), "verdict": 1, "expiry": now + 900}
    sig, _ = sign_attestation(K["evaluator"], w3.eth.chain_id, c.address, msg)
    tup = (cid, bytes.fromhex(msg["specDigest"][2:]), bytes.fromhex(sid[2:]), bytes.fromhex(cand_digest[2:]),
           bytes.fromhex(msg["evidenceDigest"][2:]), recipient, recipient, 1, msg["expiry"])
    r = devchain.send(w3, K["relayer"], c.functions.settle(tup, bytes.fromhex(sig[2:])))
    assert r.status == 1
    return spec, d, bundle, cid, "0x" + bytes(r.transactionHash).hex()


def test_registered_agent_declares_its_target_on_the_official_registry(fork):
    w3, _ = fork
    aid = _register(w3, K["publisher"], DIGEST)
    agent = erc8004.read_agent(w3, aid)
    assert agent["owner"] == devchain.address_of(K["publisher"])
    assert agent["artifact_digest"] == DIGEST


def test_verified_violation_becomes_feedback_on_the_official_reputation_registry(fork, spec_v1):
    w3, c = fork
    spec, d, bundle, cid, settle_tx = _settled_violation(w3, c, spec_v1)
    aid = _register(w3, K["publisher"], spec["target"]["artifact_digest"])
    reporter = devchain.address_of(K["outsider"])
    facts = erc8004.check_violation_report(w3, bounties_contract=c, onchain_id=cid, settle_tx=settle_tx, spec=spec,
                                           spec_digest=d, evidence=bundle, agent_id=aid, reporter=reporter)
    assert facts["rule_id"] == "R1" and facts["evidence_digest"] == bundle["evidence_digest"]
    f = erc8004.violation_feedback_file(**facts, endpoint=None)
    args, _ = erc8004.give_feedback_args(f)
    rep = erc8004.reputation(w3)
    r = devchain.send(w3, K["outsider"], rep.functions.giveFeedback(*args))
    assert r.status == 1
    ev = rep.events.NewFeedback().process_receipt(r, errors=DISCARD)[0]["args"]
    assert ev["agentId"] == aid and ev["clientAddress"] == reporter and ev["tag2"] == "R1"
    assert erc8004.parse_data_uri(ev["feedbackURI"]) == f
    value, decimals, tag1, tag2, revoked = rep.functions.readFeedback(aid, reporter, ev["feedbackIndex"]).call()
    assert (value, decimals, tag1, tag2, revoked) == (1, 0, erc8004.TAG_VIOLATION, "R1", False)


def test_reporter_refuses_an_agent_that_declares_different_code(fork, spec_v1):
    w3, c = fork
    spec, d, bundle, cid, settle_tx = _settled_violation(w3, c, spec_v1)
    aid = _register(w3, K["publisher"], DIGEST)  # someone else's agent: different artifact
    with pytest.raises(erc8004.Erc8004Error, match="declares artifact"):
        erc8004.check_violation_report(w3, bounties_contract=c, onchain_id=cid, settle_tx=settle_tx, spec=spec,
                                       spec_digest=d, evidence=bundle, agent_id=aid, reporter=devchain.address_of(K["outsider"]))


def test_reporter_refuses_self_feedback_and_unsettled_or_tampered_results(fork, spec_v1):
    w3, c = fork
    spec, d, bundle, cid, settle_tx = _settled_violation(w3, c, spec_v1)
    aid = _register(w3, K["publisher"], spec["target"]["artifact_digest"])
    kw = {"bounties_contract": c, "settle_tx": settle_tx, "spec": spec, "spec_digest": d, "agent_id": aid}
    with pytest.raises(erc8004.Erc8004Error, match="self-feedback"):
        erc8004.check_violation_report(w3, onchain_id=cid, evidence=bundle, reporter=devchain.address_of(K["publisher"]), **kw)
    with pytest.raises(erc8004.Erc8004Error, match="not settled"):
        erc8004.check_violation_report(w3, onchain_id=cid + 1000, evidence=bundle, reporter=devchain.address_of(K["outsider"]), **kw)
    tampered = dict(bundle, claimed_rule="R3")
    with pytest.raises(erc8004.Erc8004Error, match="not the one named|re-verification"):
        erc8004.check_violation_report(w3, onchain_id=cid, evidence=tampered, reporter=devchain.address_of(K["outsider"]), **kw)
