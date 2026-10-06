// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {CounterProofBounties} from "../src/CounterProofBounties.sol";

/// @dev Shared fixtures: keys are throwaway test keys, never real ones.
abstract contract BountiesFixture is Test {
    CounterProofBounties internal bounties;

    uint256 internal constant EVALUATOR_PK = 0xE7A1;
    uint256 internal constant OTHER_PK = 0xBAD;
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant REWARD = 1 ether;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    bytes32 internal constant SPEC = keccak256("spec: agent must never reveal the vault code");
    bytes32 internal constant CANDIDATE = keccak256("candidate transcript #1");
    bytes32 internal constant EVIDENCE = keccak256("replay evidence bundle #1");

    address internal evaluator;
    address internal publisher = makeAddr("publisher");
    address internal challenger = makeAddr("challenger");
    address internal recipient = makeAddr("recipient");
    address internal relayer = makeAddr("relayer");
    address internal attacker = makeAddr("attacker");

    function setUp() public virtual {
        vm.warp(T0);
        evaluator = vm.addr(EVALUATOR_PK);
        bounties = new CounterProofBounties();
        vm.deal(publisher, 1_000 ether);
    }

    // ----- helpers -----

    function _subDeadline() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp() + 1 days);
    }

    function _create() internal returns (uint256 id) {
        return _createOn(bounties);
    }

    function _createOn(CounterProofBounties b) internal returns (uint256 id) {
        uint64 sub = uint64(vm.getBlockTimestamp() + 1 days);
        vm.prank(publisher);
        id = b.createChallenge{value: REWARD}(SPEC, evaluator, sub, sub + 1 days);
    }

    function _commit(uint256 id, address who, bytes32 candidate, address to) internal returns (bytes32 sid) {
        return _commitOn(bounties, id, who, candidate, to);
    }

    function _commitOn(CounterProofBounties b, uint256 id, address who, bytes32 candidate, address to)
        internal
        returns (bytes32 sid)
    {
        vm.prank(who);
        sid = b.commitSubmission(id, candidate, to);
    }

    function _attestation(uint256 id, bytes32 sid, address who, bytes32 candidate, address to)
        internal
        view
        returns (CounterProofBounties.Attestation memory a)
    {
        a = CounterProofBounties.Attestation({
            challengeId: id,
            specDigest: SPEC,
            submissionId: sid,
            candidateDigest: candidate,
            evidenceDigest: EVIDENCE,
            challenger: who,
            recipient: to,
            verdict: 1,
            expiry: uint64(vm.getBlockTimestamp() + 3 days)
        });
    }

    function _sign(uint256 pk, CounterProofBounties.Attestation memory a) internal view returns (bytes memory) {
        return _signOn(bounties, pk, a);
    }

    function _signOn(CounterProofBounties b, uint256 pk, CounterProofBounties.Attestation memory a)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, b.hashAttestation(a));
        return abi.encodePacked(r, s, v);
    }

    /// @dev create -> commit -> signed attestation, ready to settle.
    function _ready()
        internal
        returns (uint256 id, bytes32 sid, CounterProofBounties.Attestation memory a, bytes memory sig)
    {
        id = _create();
        sid = _commit(id, challenger, CANDIDATE, recipient);
        a = _attestation(id, sid, challenger, CANDIDATE, recipient);
        sig = _sign(EVALUATOR_PK, a);
    }

    /// @dev Memory structs are references; this returns an independent copy.
    function _copy(CounterProofBounties.Attestation memory a)
        internal
        pure
        returns (CounterProofBounties.Attestation memory)
    {
        return abi.decode(abi.encode(a), (CounterProofBounties.Attestation));
    }

    function _assertAccounting() internal view {
        assertEq(
            address(bounties).balance, bounties.totalEscrowed() + bounties.totalCredits(), "balance != escrow+credits"
        );
    }
}

contract CounterProofBountiesTest is BountiesFixture {
    // =============================================================================================
    // Happy path
    // =============================================================================================

    function test_HappyPath_CreateCommitSettleWithdraw() public {
        uint64 sub = _subDeadline();
        uint64 settleBy = sub + 1 days;

        vm.expectEmit(true, true, true, true, address(bounties));
        emit CounterProofBounties.ChallengeCreated(1, publisher, evaluator, SPEC, REWARD, sub, settleBy);
        vm.prank(publisher);
        uint256 id = bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, settleBy);
        assertEq(id, 1);
        assertEq(bounties.challengeCount(), 1);
        assertEq(bounties.totalEscrowed(), REWARD);
        _assertAccounting();

        CounterProofBounties.Challenge memory c = bounties.getChallenge(id);
        assertEq(c.publisher, publisher);
        assertEq(c.evaluator, evaluator);
        assertEq(c.submissionDeadline, sub);
        assertEq(c.settlementDeadline, settleBy);
        assertEq(uint8(c.status), uint8(CounterProofBounties.Status.Funded));
        assertEq(c.reward, REWARD);
        assertEq(c.specDigest, SPEC);
        assertEq(c.settledSubmission, bytes32(0));

        bytes32 expectedSid = bounties.submissionIdFor(id, challenger, CANDIDATE);
        assertEq(expectedSid, keccak256(abi.encode(block.chainid, address(bounties), id, challenger, CANDIDATE)));
        vm.expectEmit(true, true, true, true, address(bounties));
        emit CounterProofBounties.SubmissionCommitted(id, expectedSid, challenger, recipient, CANDIDATE);
        bytes32 sid = _commit(id, challenger, CANDIDATE, recipient);
        assertEq(sid, expectedSid);

        CounterProofBounties.Submission memory s = bounties.getSubmission(sid);
        assertEq(s.challengeId, id);
        assertEq(s.challenger, challenger);
        assertEq(s.recipient, recipient);
        assertEq(s.committedAt, uint64(vm.getBlockTimestamp()));
        assertEq(s.candidateDigest, CANDIDATE);

        vm.warp(vm.getBlockTimestamp() + 2 hours);
        CounterProofBounties.Attestation memory a = _attestation(id, sid, challenger, CANDIDATE, recipient);
        bytes memory sig = _sign(EVALUATOR_PK, a);

        vm.expectEmit(true, true, true, true, address(bounties));
        emit CounterProofBounties.ChallengeSettled(id, sid, recipient, REWARD, EVIDENCE);
        vm.prank(challenger);
        bounties.settle(a, sig);

        c = bounties.getChallenge(id);
        assertEq(uint8(c.status), uint8(CounterProofBounties.Status.Settled));
        assertEq(c.settledSubmission, sid);
        assertEq(bounties.credits(recipient), REWARD);
        assertEq(bounties.totalEscrowed(), 0);
        assertEq(bounties.totalCredits(), REWARD);
        _assertAccounting();

        uint256 before = recipient.balance;
        vm.expectEmit(true, true, true, true, address(bounties));
        emit CounterProofBounties.Withdrawn(recipient, recipient, REWARD);
        vm.prank(recipient);
        bounties.withdraw();
        assertEq(recipient.balance, before + REWARD);
        assertEq(bounties.credits(recipient), 0);
        assertEq(bounties.totalCredits(), 0);
        assertEq(address(bounties).balance, 0);
        _assertAccounting();
    }

    // =============================================================================================
    // EIP-712 encoding (an off-chain Python signer depends on these exact values)
    // =============================================================================================

    function test_TypehashIsExactString() public view {
        assertEq(
            bounties.ATTESTATION_TYPEHASH(),
            keccak256(
                "Attestation(uint256 challengeId,bytes32 specDigest,bytes32 submissionId,bytes32 candidateDigest,bytes32 evidenceDigest,address challenger,address recipient,uint8 verdict,uint64 expiry)"
            )
        );
    }

    function test_DomainAndDigestMatchManualEip712() public view {
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("CounterProof")),
                keccak256(bytes("1")),
                block.chainid,
                address(bounties)
            )
        );
        assertEq(bounties.domainSeparator(), expectedDomain);

        (, string memory name, string memory version, uint256 chainId, address verifying,,) = bounties.eip712Domain();
        assertEq(name, "CounterProof");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifying, address(bounties));

        CounterProofBounties.Attestation memory a = _attestation(7, keccak256("sid"), challenger, CANDIDATE, recipient);
        bytes32 structHash = keccak256(
            abi.encode(
                bounties.ATTESTATION_TYPEHASH(),
                a.challengeId,
                a.specDigest,
                a.submissionId,
                a.candidateDigest,
                a.evidenceDigest,
                a.challenger,
                a.recipient,
                a.verdict,
                a.expiry
            )
        );
        assertEq(bounties.hashAttestation(a), keccak256(abi.encodePacked("\x19\x01", expectedDomain, structHash)));
    }

    /// Pinned cross-language vector, produced by eth-account 0.14.0 `Account.sign_typed_data` with the
    /// throwaway test key 0xE7A1, chain id 10143 (Monad testnet) and a fixed contract address. If this
    /// test breaks, the off-chain Python signer and the contract no longer agree on the EIP-712 encoding.
    function test_PythonEthAccountVectorSettles() public {
        address at = 0xC0FFEe0000000000000000000000000000000001;
        address vecChallenger = 0x1111111111111111111111111111111111111111;
        address vecRecipient = 0x2222222222222222222222222222222222222222;
        vm.chainId(10143);
        deployCodeTo("CounterProofBounties.sol:CounterProofBounties", at);
        CounterProofBounties b = CounterProofBounties(at);

        uint64 sub = _subDeadline();
        vm.prank(publisher);
        uint256 id = b.createChallenge{value: REWARD}(SPEC, evaluator, sub, sub + 1 days);
        vm.prank(vecChallenger);
        bytes32 sid = b.commitSubmission(id, CANDIDATE, vecRecipient);
        assertEq(sid, 0x67ddc0ffd6c95c2c1f250168ca8ea803e066c4f901425ccdf8736f2c24d0b71c, "submissionId");

        CounterProofBounties.Attestation memory a = CounterProofBounties.Attestation({
            challengeId: id,
            specDigest: SPEC,
            submissionId: sid,
            candidateDigest: CANDIDATE,
            evidenceDigest: EVIDENCE,
            challenger: vecChallenger,
            recipient: vecRecipient,
            verdict: 1,
            expiry: 2_000_000_000
        });
        assertEq(b.hashAttestation(a), 0x37dd47c6963a849c77ac0258ba269bac8daae8579b692bfb82fcb5a2bb58b2df, "digest");

        vm.prank(relayer);
        b.settle(
            a,
            hex"d9da0537db73eeb00324408e988ef091050d94c4be4892522a079f4317f2b67b75e4a41b2929531ae99de524fdd1f1ed71bed00c20f0e878dd415748e47e5c0e1c"
        );
        assertEq(b.credits(vecRecipient), REWARD);
    }

    function test_DirectEtherTransferIsRejected() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(bounties).call{value: 1 ether}("");
        assertFalse(ok);
        _assertAccounting();
    }

    // =============================================================================================
    // createChallenge validation
    // =============================================================================================

    function test_Create_RevertsOnZeroValue() public {
        uint64 sub = _subDeadline();
        vm.prank(publisher);
        vm.expectRevert(CounterProofBounties.ZeroReward.selector);
        bounties.createChallenge{value: 0}(SPEC, evaluator, sub, sub + 1 days);
    }

    function test_Create_RevertsOnZeroSpecDigest() public {
        uint64 sub = _subDeadline();
        vm.prank(publisher);
        vm.expectRevert(CounterProofBounties.ZeroSpecDigest.selector);
        bounties.createChallenge{value: REWARD}(bytes32(0), evaluator, sub, sub + 1 days);
    }

    function test_Create_RevertsOnZeroEvaluator() public {
        uint64 sub = _subDeadline();
        vm.prank(publisher);
        vm.expectRevert(CounterProofBounties.ZeroEvaluator.selector);
        bounties.createChallenge{value: REWARD}(SPEC, address(0), sub, sub + 1 days);
    }

    function test_Create_RevertsOnPastOrCurrentSubmissionDeadline() public {
        uint64 nowTs = uint64(vm.getBlockTimestamp());
        vm.startPrank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(
                CounterProofBounties.SubmissionDeadlineNotInFuture.selector, nowTs, vm.getBlockTimestamp()
            )
        );
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, nowTs, nowTs + 1 days);

        vm.expectRevert(
            abi.encodeWithSelector(
                CounterProofBounties.SubmissionDeadlineNotInFuture.selector, nowTs - 1, vm.getBlockTimestamp()
            )
        );
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, nowTs - 1, nowTs + 1 days);
        vm.stopPrank();
    }

    function test_Create_RevertsWhenSubmissionPeriodTooLong() public {
        uint256 max = bounties.MAX_SUBMISSION_PERIOD();
        uint64 sub = uint64(vm.getBlockTimestamp() + max + 1);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SubmissionPeriodTooLong.selector, max + 1, max));
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, sub + 1 days);

        // Exactly the maximum is allowed.
        sub = uint64(vm.getBlockTimestamp() + max);
        vm.prank(publisher);
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, sub + 1 days);
    }

    function test_Create_RevertsWhenSettlementNotAfterSubmission() public {
        uint64 sub = _subDeadline();
        vm.startPrank(publisher);
        vm.expectRevert(
            abi.encodeWithSelector(CounterProofBounties.SettlementDeadlineNotAfterSubmissionDeadline.selector, sub, sub)
        );
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, sub);
        vm.expectRevert(
            abi.encodeWithSelector(
                CounterProofBounties.SettlementDeadlineNotAfterSubmissionDeadline.selector, sub, sub - 1
            )
        );
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, sub - 1);
        vm.stopPrank();
    }

    function test_Create_RevertsWhenWindowTooShort() public {
        uint64 sub = _subDeadline();
        uint256 min = bounties.MIN_SETTLEMENT_WINDOW();
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SettlementWindowTooShort.selector, min - 1, min));
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, uint64(sub + min - 1));

        // Exactly the minimum is allowed.
        vm.prank(publisher);
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, uint64(sub + min));
    }

    function test_Create_RevertsWhenWindowTooLong() public {
        uint64 sub = _subDeadline();
        uint256 max = bounties.MAX_SETTLEMENT_WINDOW();
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SettlementWindowTooLong.selector, max + 1, max));
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, uint64(sub + max + 1));

        // Exactly the maximum is allowed.
        vm.prank(publisher);
        bounties.createChallenge{value: REWARD}(SPEC, evaluator, sub, uint64(sub + max));
    }

    function test_Create_IdsIncrementAndEscrowAccumulates() public {
        assertEq(_create(), 1);
        assertEq(_create(), 2);
        assertEq(bounties.challengeCount(), 2);
        assertEq(bounties.totalEscrowed(), 2 * REWARD);
        _assertAccounting();
    }

    // =============================================================================================
    // commitSubmission
    // =============================================================================================

    function test_Commit_AtDeadlineOkAfterDeadlineReverts() public {
        uint256 id = _create();
        uint64 sub = bounties.getChallenge(id).submissionDeadline;

        vm.warp(sub);
        _commit(id, challenger, CANDIDATE, recipient);

        vm.warp(uint256(sub) + 1);
        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SubmissionPeriodOver.selector, id, sub));
        bounties.commitSubmission(id, keccak256("late"), recipient);
    }

    function test_Commit_DuplicateReverts() public {
        uint256 id = _create();
        bytes32 sid = _commit(id, challenger, CANDIDATE, recipient);
        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadyCommitted.selector, sid));
        bounties.commitSubmission(id, CANDIDATE, attacker); // a different recipient does not help
    }

    function test_Commit_SameCandidateByDifferentChallengersGetsDistinctIds() public {
        uint256 id = _create();
        bytes32 sid1 = _commit(id, challenger, CANDIDATE, recipient);
        bytes32 sid2 = _commit(id, attacker, CANDIDATE, attacker);
        assertTrue(sid1 != sid2);
        assertEq(bounties.getSubmission(sid1).recipient, recipient);
        assertEq(bounties.getSubmission(sid2).recipient, attacker);
    }

    function test_Commit_NonexistentChallengeReverts() public {
        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.ChallengeNotFound.selector, 99));
        bounties.commitSubmission(99, CANDIDATE, recipient);

        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.ChallengeNotFound.selector, 0));
        bounties.commitSubmission(0, CANDIDATE, recipient);
    }

    function test_Commit_NoLongerFundedChallengeReverts() public {
        // Settled challenge.
        (uint256 id,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bounties.settle(a, sig);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadySettled.selector, id));
        bounties.commitSubmission(id, keccak256("x"), attacker);

        // Refunded challenge (cannot be reached before the submission deadline, but must still be closed).
        uint256 id2 = _create();
        vm.warp(uint256(bounties.getChallenge(id2).settlementDeadline) + 1);
        bounties.refund(id2);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadyRefunded.selector, id2));
        bounties.commitSubmission(id2, keccak256("x"), attacker);
    }

    function test_Commit_ZeroRecipientReverts() public {
        uint256 id = _create();
        vm.prank(challenger);
        vm.expectRevert(CounterProofBounties.ZeroRecipient.selector);
        bounties.commitSubmission(id, CANDIDATE, address(0));
    }

    function test_Commit_ZeroCandidateDigestReverts() public {
        uint256 id = _create();
        vm.prank(challenger);
        vm.expectRevert(CounterProofBounties.ZeroCandidateDigest.selector);
        bounties.commitSubmission(id, bytes32(0), recipient);
    }

    // =============================================================================================
    // settle: rejections
    // =============================================================================================

    function test_Settle_RejectsWrongSigner() public {
        (,, CounterProofBounties.Attestation memory a,) = _ready();
        bytes memory badSig = _sign(OTHER_PK, a);
        vm.expectRevert(
            abi.encodeWithSelector(CounterProofBounties.SignerNotEvaluator.selector, vm.addr(OTHER_PK), evaluator)
        );
        bounties.settle(a, badSig);
    }

    function test_Settle_RejectsAlteredRecipient() public {
        (, bytes32 sid, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        a.recipient = attacker;
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SubmissionMismatch.selector, sid));
        bounties.settle(a, sig);
    }

    function test_Settle_RejectsAlteredChallenger() public {
        (, bytes32 sid, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        a.challenger = attacker;
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SubmissionMismatch.selector, sid));
        bounties.settle(a, sig);
    }

    function test_Settle_RejectsAlteredCandidateDigest() public {
        (, bytes32 sid, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        a.candidateDigest = keccak256("some other candidate");
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SubmissionMismatch.selector, sid));
        bounties.settle(a, sig);
    }

    function test_Settle_RejectsAlteredSpecDigest() public {
        (,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bytes32 otherSpec = keccak256("other spec");
        a.specDigest = otherSpec;
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SpecDigestMismatch.selector, SPEC, otherSpec));
        bounties.settle(a, sig);
    }

    /// Fields that only the signature protects (storage cannot catch them).
    function test_Settle_RejectsAlteredEvidenceOrExpiry() public {
        (,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();

        CounterProofBounties.Attestation memory b = _copy(a);
        b.evidenceDigest = keccak256("forged evidence");
        address recovered = ECDSA.recover(bounties.hashAttestation(b), sig);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SignerNotEvaluator.selector, recovered, evaluator));
        bounties.settle(b, sig);

        CounterProofBounties.Attestation memory c = _copy(a);
        c.expiry = a.expiry + 30 days;
        recovered = ECDSA.recover(bounties.hashAttestation(c), sig);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SignerNotEvaluator.selector, recovered, evaluator));
        bounties.settle(c, sig);
    }

    function test_Settle_RejectsUnknownSubmission() public {
        (,, CounterProofBounties.Attestation memory a,) = _ready();
        bytes32 bogus = keccak256("never committed");
        a.submissionId = bogus;
        bytes memory sig = _sign(EVALUATOR_PK, a); // even a correctly signed attestation needs a commit
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.UnknownSubmission.selector, bogus));
        bounties.settle(a, sig);
    }

    function test_Settle_RejectsSubmissionOfAnotherChallenge() public {
        uint256 id1 = _create();
        uint256 id2 = _create(); // same spec digest on purpose
        bytes32 sid2 = _commit(id2, challenger, CANDIDATE, recipient);
        CounterProofBounties.Attestation memory a = _attestation(id1, sid2, challenger, CANDIDATE, recipient);
        bytes memory sig = _sign(EVALUATOR_PK, a);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SubmissionMismatch.selector, sid2));
        bounties.settle(a, sig);
    }

    /// Someone who copies a committed candidate digest under their own address cannot reuse the
    /// evaluator's attestation for the original submission.
    function test_Settle_CopiedDigestCannotReuseAttestation() public {
        (, bytes32 sid, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bytes32 copySid = _commit(a.challengeId, attacker, CANDIDATE, attacker);

        CounterProofBounties.Attestation memory forged = _copy(a);
        forged.submissionId = copySid;
        forged.challenger = attacker;
        forged.recipient = attacker;
        address recovered = ECDSA.recover(bounties.hashAttestation(forged), sig);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SignerNotEvaluator.selector, recovered, evaluator));
        bounties.settle(forged, sig);

        // The genuine attestation still pays the genuine recipient.
        bounties.settle(a, sig);
        assertEq(bounties.getChallenge(a.challengeId).settledSubmission, sid);
        assertEq(bounties.credits(recipient), REWARD);
        assertEq(bounties.credits(attacker), 0);
    }

    function test_Settle_RejectsVerdictZeroAndTwo() public {
        (,, CounterProofBounties.Attestation memory a,) = _ready();

        a.verdict = 0;
        bytes memory sig0 = _sign(EVALUATOR_PK, a);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.VerdictNotViolation.selector, uint8(0)));
        bounties.settle(a, sig0);

        a.verdict = 2;
        bytes memory sig2 = _sign(EVALUATOR_PK, a);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.VerdictNotViolation.selector, uint8(2)));
        bounties.settle(a, sig2);
    }

    function test_Settle_RejectsZeroEvidenceDigest() public {
        (,, CounterProofBounties.Attestation memory a,) = _ready();
        a.evidenceDigest = bytes32(0);
        bytes memory sig = _sign(EVALUATOR_PK, a);
        vm.expectRevert(CounterProofBounties.ZeroEvidenceDigest.selector);
        bounties.settle(a, sig);
    }

    function test_Settle_ExpiredAttestationReverts_AtExpiryOk() public {
        (,, CounterProofBounties.Attestation memory a,) = _ready();
        a.expiry = uint64(vm.getBlockTimestamp() + 10 minutes);
        bytes memory sig = _sign(EVALUATOR_PK, a);

        uint256 snap = vm.snapshotState();
        vm.warp(uint256(a.expiry) + 1);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AttestationExpired.selector, a.expiry));
        bounties.settle(a, sig);

        vm.revertToState(snap);
        vm.warp(a.expiry);
        bounties.settle(a, sig);
        assertEq(bounties.credits(recipient), REWARD);
    }

    function test_Settle_AfterSettlementDeadlineReverts_AtDeadlineOk() public {
        (uint256 id,, CounterProofBounties.Attestation memory a,) = _ready();
        uint64 deadline = bounties.getChallenge(id).settlementDeadline;
        a.expiry = deadline + 30 days; // expiry is not the limiting factor here
        bytes memory sig = _sign(EVALUATOR_PK, a);

        uint256 snap = vm.snapshotState();
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SettlementDeadlinePassed.selector, id, deadline));
        bounties.settle(a, sig);

        vm.revertToState(snap);
        vm.warp(deadline);
        bounties.settle(a, sig);
        assertEq(uint8(bounties.getChallenge(id).status), uint8(CounterProofBounties.Status.Settled));
    }

    function test_Settle_DoubleSettleSameAttestationReverts() public {
        (uint256 id,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bounties.settle(a, sig);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadySettled.selector, id));
        bounties.settle(a, sig);
        assertEq(bounties.credits(recipient), REWARD);
        _assertAccounting();
    }

    function test_Settle_SecondDifferentValidAttestationReverts() public {
        (uint256 id, bytes32 sid1, CounterProofBounties.Attestation memory a1, bytes memory sig1) = _ready();
        address challenger2 = makeAddr("challenger2");
        address recipient2 = makeAddr("recipient2");
        bytes32 candidate2 = keccak256("candidate transcript #2");
        bytes32 sid2 = _commit(id, challenger2, candidate2, recipient2);
        CounterProofBounties.Attestation memory a2 = _attestation(id, sid2, challenger2, candidate2, recipient2);
        bytes memory sig2 = _sign(EVALUATOR_PK, a2);

        bounties.settle(a1, sig1); // first eligible settlement wins
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadySettled.selector, id));
        bounties.settle(a2, sig2);

        assertEq(bounties.getChallenge(id).settledSubmission, sid1);
        assertEq(bounties.credits(recipient), REWARD);
        assertEq(bounties.credits(recipient2), 0);
    }

    function test_Settle_AfterRefundReverts() public {
        (uint256 id,, CounterProofBounties.Attestation memory a,) = _ready();
        uint64 deadline = bounties.getChallenge(id).settlementDeadline;
        a.expiry = deadline + 30 days;
        bytes memory sig = _sign(EVALUATOR_PK, a);

        vm.warp(uint256(deadline) + 1);
        bounties.refund(id);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadyRefunded.selector, id));
        bounties.settle(a, sig);
    }

    function test_Settle_NonexistentChallengeReverts() public {
        (,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        a.challengeId = 42;
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.ChallengeNotFound.selector, 42));
        bounties.settle(a, sig);
    }

    function test_Settle_RejectsCrossContractReplay() public {
        CounterProofBounties other = new CounterProofBounties();
        (uint256 id, bytes32 sidA, CounterProofBounties.Attestation memory aA, bytes memory sigA) = _ready();

        // Identical challenge and commitment on a second deployment.
        uint256 idB = _createOn(other);
        assertEq(idB, id);
        bytes32 sidB = _commitOn(other, idB, challenger, CANDIDATE, recipient);
        assertTrue(sidA != sidB, "submission ids bind the contract address");

        // 1) Replaying the exact (attestation, signature) pair fails.
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.UnknownSubmission.selector, sidA));
        other.settle(aA, sigA);

        // 2) Even with B's submission id, a signature made over A's domain fails on B.
        CounterProofBounties.Attestation memory aB = _attestation(idB, sidB, challenger, CANDIDATE, recipient);
        bytes memory sigOverA = _signOn(bounties, EVALUATOR_PK, aB);
        address recovered = ECDSA.recover(other.hashAttestation(aB), sigOverA);
        assertTrue(recovered != evaluator);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SignerNotEvaluator.selector, recovered, evaluator));
        other.settle(aB, sigOverA);

        // Positive control: signed over B's own domain, it settles on B.
        other.settle(aB, _signOn(other, EVALUATOR_PK, aB));
        assertEq(other.credits(recipient), REWARD);
        assertEq(bounties.credits(recipient), 0);
    }

    function test_Settle_RejectsCrossChainReplay() public {
        (,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bytes32 domainBefore = bounties.domainSeparator();

        vm.chainId(block.chainid + 1);
        assertTrue(bounties.domainSeparator() != domainBefore, "domain must follow chain id");
        address recovered = ECDSA.recover(bounties.hashAttestation(a), sig);
        assertTrue(recovered != evaluator);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.SignerNotEvaluator.selector, recovered, evaluator));
        bounties.settle(a, sig);

        // Positive control: the only thing wrong was the chain id in the signed domain.
        bounties.settle(a, _sign(EVALUATOR_PK, a));
        assertEq(bounties.credits(recipient), REWARD);
    }

    function test_Settle_RejectsMalleableHighS() public {
        (,, CounterProofBounties.Attestation memory a,) = _ready();
        bytes32 digest = bounties.hashAttestation(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EVALUATOR_PK, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        // Raw ecrecover accepts the twin signature: this is exactly what must be rejected.
        assertEq(ecrecover(digest, flippedV, r, highS), evaluator);

        vm.expectRevert(
            abi.encodeWithSelector(CounterProofBounties.InvalidSignature.selector, ECDSA.RecoverError.InvalidSignatureS)
        );
        bounties.settle(a, abi.encodePacked(r, highS, flippedV));

        // The canonical low-s signature still works.
        bounties.settle(a, abi.encodePacked(r, s, v));
        assertEq(bounties.credits(recipient), REWARD);
    }

    function test_Settle_RejectsBadSignatureLength() public {
        (,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bytes memory shortSig = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            shortSig[i] = sig[i];
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                CounterProofBounties.InvalidSignature.selector, ECDSA.RecoverError.InvalidSignatureLength
            )
        );
        bounties.settle(a, shortSig);
    }

    function test_Settle_ByThirdPartyRelayerCreditsRecipient() public {
        (uint256 id, bytes32 sid, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        vm.prank(relayer);
        bounties.settle(a, sig);
        assertEq(bounties.getChallenge(id).settledSubmission, sid);
        assertEq(bounties.credits(recipient), REWARD);
        assertEq(bounties.credits(relayer), 0);
        assertEq(bounties.credits(challenger), 0);

        vm.prank(relayer);
        vm.expectRevert(CounterProofBounties.NothingToWithdraw.selector);
        bounties.withdraw();
    }

    function test_Settle_BeforeSubmissionDeadlineIsAllowed() public {
        (uint256 id,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        assertLt(vm.getBlockTimestamp(), bounties.getChallenge(id).submissionDeadline);
        bounties.settle(a, sig);
        assertEq(uint8(bounties.getChallenge(id).status), uint8(CounterProofBounties.Status.Settled));
    }

    // =============================================================================================
    // refund
    // =============================================================================================

    function test_Refund_BeforeOrAtDeadlineReverts() public {
        uint256 id = _create();
        uint64 deadline = bounties.getChallenge(id).settlementDeadline;

        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.RefundTooEarly.selector, id, deadline));
        bounties.refund(id);

        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.RefundTooEarly.selector, id, deadline));
        bounties.refund(id);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.RefundTooEarly.selector, id, deadline));
        bounties.refund(id);
    }

    function test_Refund_AfterDeadlineCreditsPublisher_AnyoneMayTrigger() public {
        uint256 id = _create();
        uint64 deadline = bounties.getChallenge(id).settlementDeadline;
        vm.warp(uint256(deadline) + 1);

        vm.expectEmit(true, true, true, true, address(bounties));
        emit CounterProofBounties.ChallengeRefunded(id, publisher, REWARD);
        vm.prank(relayer);
        bounties.refund(id);

        assertEq(uint8(bounties.getChallenge(id).status), uint8(CounterProofBounties.Status.Refunded));
        assertEq(bounties.credits(publisher), REWARD);
        assertEq(bounties.credits(relayer), 0);
        assertEq(bounties.totalEscrowed(), 0);
        assertEq(bounties.totalCredits(), REWARD);
        _assertAccounting();

        uint256 before = publisher.balance;
        vm.prank(publisher);
        bounties.withdraw();
        assertEq(publisher.balance, before + REWARD);
        _assertAccounting();
    }

    function test_Refund_TwiceReverts() public {
        uint256 id = _create();
        vm.warp(uint256(bounties.getChallenge(id).settlementDeadline) + 1);
        bounties.refund(id);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadyRefunded.selector, id));
        bounties.refund(id);
        assertEq(bounties.credits(publisher), REWARD);
    }

    function test_Refund_AfterSettleReverts() public {
        (uint256 id,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bounties.settle(a, sig);
        vm.warp(uint256(bounties.getChallenge(id).settlementDeadline) + 1);
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.AlreadySettled.selector, id));
        bounties.refund(id);
        assertEq(bounties.credits(publisher), 0);
    }

    function test_Refund_NonexistentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.ChallengeNotFound.selector, 5));
        bounties.refund(5);
    }

    // =============================================================================================
    // withdraw / withdrawTo
    // =============================================================================================

    function test_Withdraw_TransfersExactlyOnce() public {
        (,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bounties.settle(a, sig);

        uint256 before = recipient.balance;
        vm.prank(recipient);
        bounties.withdraw();
        assertEq(recipient.balance, before + REWARD);

        vm.prank(recipient);
        vm.expectRevert(CounterProofBounties.NothingToWithdraw.selector);
        bounties.withdraw();

        vm.prank(recipient);
        vm.expectRevert(CounterProofBounties.NothingToWithdraw.selector);
        bounties.withdrawTo(payable(attacker));

        assertEq(recipient.balance, before + REWARD);
        assertEq(attacker.balance, 0);
        _assertAccounting();
    }

    function test_WithdrawTo_ZeroAddressReverts() public {
        (,, CounterProofBounties.Attestation memory a, bytes memory sig) = _ready();
        bounties.settle(a, sig);
        vm.prank(recipient);
        vm.expectRevert(CounterProofBounties.ZeroRecipient.selector);
        bounties.withdrawTo(payable(address(0)));
        assertEq(bounties.credits(recipient), REWARD);
    }

    function test_Withdraw_ReentrantRecipientCannotDoubleWithdraw() public {
        ReentrantRecipient evil = new ReentrantRecipient(bounties);
        uint256 id = _create();
        bytes32 sid = _commit(id, challenger, CANDIDATE, address(evil));
        CounterProofBounties.Attestation memory a = _attestation(id, sid, challenger, CANDIDATE, address(evil));
        bounties.settle(a, _sign(EVALUATOR_PK, a));

        // Extra unrelated escrow that a successful re-entry would try to drain.
        _create();
        assertEq(address(bounties).balance, 2 * REWARD);

        evil.pull();

        assertEq(evil.receiveCount(), 1, "received exactly once");
        assertEq(address(evil).balance, REWARD, "paid exactly the reward");
        assertEq(bounties.credits(address(evil)), 0);
        bytes memory guardErr = abi.encodeWithSelector(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(evil.withdrawReentryError(), guardErr, "withdraw re-entry blocked by guard");
        assertEq(evil.withdrawToReentryError(), guardErr, "withdrawTo re-entry blocked by guard");
        assertEq(address(bounties).balance, REWARD, "other escrow untouched");
        _assertAccounting();

        vm.expectRevert(CounterProofBounties.NothingToWithdraw.selector);
        evil.pull();
    }

    function test_RevertingRecipient_SettleOk_WithdrawReverts_WithdrawToWorks() public {
        RevertingRecipient stubborn = new RevertingRecipient(bounties);
        uint256 id = _create();
        bytes32 sid = _commit(id, challenger, CANDIDATE, address(stubborn));
        CounterProofBounties.Attestation memory a = _attestation(id, sid, challenger, CANDIDATE, address(stubborn));

        // Settlement never calls the recipient, so it cannot be blocked by it.
        bounties.settle(a, _sign(EVALUATOR_PK, a));
        assertEq(bounties.credits(address(stubborn)), REWARD);

        vm.expectRevert(abi.encodeWithSelector(CounterProofBounties.TransferFailed.selector, address(stubborn), REWARD));
        stubborn.pull();
        assertEq(bounties.credits(address(stubborn)), REWARD, "credit preserved after failed transfer");
        assertEq(bounties.totalCredits(), REWARD);
        _assertAccounting();

        address payable safe = payable(makeAddr("safe wallet"));
        stubborn.pullTo(safe);
        assertEq(safe.balance, REWARD);
        assertEq(bounties.credits(address(stubborn)), 0);
        assertEq(address(bounties).balance, 0);
        _assertAccounting();
    }

    // =============================================================================================
    // Accounting fuzz (stateless); the stateful invariant lives in CounterProofBountiesInvariantTest
    // =============================================================================================

    function testFuzz_AccountingAcrossLifecycle(
        uint96 rewardSeed,
        uint32 subOffset,
        uint32 window,
        uint32 settleAt,
        bool doSettle,
        bool useWithdrawTo
    ) public {
        uint256 reward = _bound(rewardSeed, 1, 500 ether);
        uint64 sub = uint64(vm.getBlockTimestamp() + _bound(subOffset, 1, bounties.MAX_SUBMISSION_PERIOD()));
        uint64 settleBy =
            uint64(sub + _bound(window, bounties.MIN_SETTLEMENT_WINDOW(), bounties.MAX_SETTLEMENT_WINDOW()));

        vm.prank(publisher);
        uint256 id = bounties.createChallenge{value: reward}(SPEC, evaluator, sub, settleBy);
        _assertAccounting();

        bytes32 sid = _commit(id, challenger, CANDIDATE, recipient);
        _assertAccounting();

        address payee;
        if (doSettle) {
            vm.warp(_bound(settleAt, vm.getBlockTimestamp(), settleBy));
            CounterProofBounties.Attestation memory a = _attestation(id, sid, challenger, CANDIDATE, recipient);
            a.expiry = settleBy;
            vm.prank(relayer);
            bounties.settle(a, _sign(EVALUATOR_PK, a));
            payee = recipient;
        } else {
            vm.warp(uint256(settleBy) + 1 + (settleAt % 30 days));
            bounties.refund(id);
            payee = publisher;
        }
        assertEq(bounties.credits(payee), reward);
        assertEq(bounties.totalEscrowed(), 0);
        _assertAccounting();

        address to = useWithdrawTo ? makeAddr("cold wallet") : payee;
        uint256 before = to.balance;
        vm.prank(payee);
        if (useWithdrawTo) bounties.withdrawTo(payable(to));
        else bounties.withdraw();
        assertEq(to.balance, before + reward);
        assertEq(address(bounties).balance, 0);
        _assertAccounting();
    }
}

// =================================================================================================
// Stateful invariant: address(this).balance == totalEscrowed + totalCredits across random sequences
// =================================================================================================

contract BountiesHandler is Test {
    CounterProofBounties public immutable bounties;
    uint256 internal immutable evaluatorPk;
    address internal immutable evaluator;

    address[] internal actors;
    uint256[] internal ids;
    bytes32[] internal sids;

    uint256 public ghostCreated;
    uint256 public ghostCommitted;
    uint256 public ghostSettled;
    uint256 public ghostRefunded;
    uint256 public ghostWithdrawn;

    constructor(CounterProofBounties b, uint256 pk) {
        bounties = b;
        evaluatorPk = pk;
        evaluator = vm.addr(pk);
        for (uint256 i; i < 5; ++i) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function challengeIds() external view returns (uint256[] memory) {
        return ids;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function create(uint256 actorSeed, uint96 valueSeed, uint32 subOffset, uint32 window) external {
        address publisher = _actor(actorSeed);
        uint256 value = _bound(valueSeed, 1, 100 ether);
        uint64 sub = uint64(vm.getBlockTimestamp() + _bound(subOffset, 1, 3 days));
        uint64 settleBy = uint64(sub + _bound(window, 5 minutes, 3 days));
        vm.deal(publisher, publisher.balance + value);
        vm.prank(publisher);
        uint256 id =
            bounties.createChallenge{value: value}(keccak256(abi.encode("spec", ids.length)), evaluator, sub, settleBy);
        ids.push(id);
        ++ghostCreated;
    }

    function commit(uint256 idSeed, uint256 challengerSeed, uint256 recipientSeed, bytes32 candidate) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        CounterProofBounties.Challenge memory c = bounties.getChallenge(id);
        if (c.status != CounterProofBounties.Status.Funded || vm.getBlockTimestamp() > c.submissionDeadline) return;
        if (candidate == bytes32(0)) candidate = keccak256("non-zero candidate");
        address who = _actor(challengerSeed);
        bytes32 sid = bounties.submissionIdFor(id, who, candidate);
        if (bounties.getSubmission(sid).challenger != address(0)) return;
        vm.prank(who);
        bounties.commitSubmission(id, candidate, _actor(recipientSeed));
        sids.push(sid);
        ++ghostCommitted;
    }

    function settle(uint256 sidSeed, uint256 relayerSeed) external {
        if (sids.length == 0) return;
        bytes32 sid = sids[sidSeed % sids.length];
        CounterProofBounties.Submission memory s = bounties.getSubmission(sid);
        CounterProofBounties.Challenge memory c = bounties.getChallenge(s.challengeId);
        if (c.status != CounterProofBounties.Status.Funded || vm.getBlockTimestamp() > c.settlementDeadline) return;
        CounterProofBounties.Attestation memory a = CounterProofBounties.Attestation({
            challengeId: s.challengeId,
            specDigest: c.specDigest,
            submissionId: sid,
            candidateDigest: s.candidateDigest,
            evidenceDigest: keccak256(abi.encode("evidence", sid)),
            challenger: s.challenger,
            recipient: s.recipient,
            verdict: 1,
            expiry: uint64(vm.getBlockTimestamp())
        });
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(evaluatorPk, bounties.hashAttestation(a));
        vm.prank(_actor(relayerSeed));
        bounties.settle(a, abi.encodePacked(r, sg, v));
        ++ghostSettled;
    }

    function refund(uint256 idSeed) external {
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        CounterProofBounties.Challenge memory c = bounties.getChallenge(id);
        if (c.status != CounterProofBounties.Status.Funded || vm.getBlockTimestamp() <= c.settlementDeadline) return;
        bounties.refund(id);
        ++ghostRefunded;
    }

    function withdraw(uint256 actorSeed, uint256 toSeed, bool useWithdrawTo) external {
        address who = _actor(actorSeed);
        if (bounties.credits(who) == 0) return;
        vm.prank(who);
        if (useWithdrawTo) bounties.withdrawTo(payable(_actor(toSeed)));
        else bounties.withdraw();
        ++ghostWithdrawn;
    }

    function warp(uint32 dt) external {
        vm.warp(vm.getBlockTimestamp() + _bound(dt, 0, 2 days));
    }
}

contract CounterProofBountiesInvariantTest is Test {
    CounterProofBounties internal bounties;
    BountiesHandler internal handler;

    function setUp() public {
        vm.warp(1_750_000_000);
        bounties = new CounterProofBounties();
        handler = new BountiesHandler(bounties, 0xE7A1);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = BountiesHandler.create.selector;
        selectors[1] = BountiesHandler.commit.selector;
        selectors[2] = BountiesHandler.settle.selector;
        selectors[3] = BountiesHandler.refund.selector;
        selectors[4] = BountiesHandler.withdraw.selector;
        selectors[5] = BountiesHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_BalanceEqualsEscrowPlusCredits() public view {
        assertEq(address(bounties).balance, bounties.totalEscrowed() + bounties.totalCredits());
    }

    function invariant_CreditsSumToTotalCredits() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += bounties.credits(handler.actorAt(i));
        }
        assertEq(sum, bounties.totalCredits());
    }

    function invariant_EscrowEqualsFundedRewards() public view {
        uint256[] memory list = handler.challengeIds();
        uint256 sum;
        for (uint256 i; i < list.length; ++i) {
            CounterProofBounties.Challenge memory c = bounties.getChallenge(list[i]);
            if (c.status == CounterProofBounties.Status.Funded) sum += c.reward;
            if (c.status == CounterProofBounties.Status.Settled) assertTrue(c.settledSubmission != bytes32(0));
        }
        assertEq(sum, bounties.totalEscrowed());
    }

    /// Deterministic check that the handler really reaches every path (so the invariant is not vacuous).
    function test_HandlerReachesEveryPath() public {
        handler.create(0, 5 ether, 1 hours, 1 hours);
        handler.create(1, 7 ether, 1 hours, 1 hours);
        handler.commit(0, 2, 3, keccak256("c1"));
        handler.commit(1, 4, 4, keccak256("c2"));
        handler.settle(0, 1);
        handler.warp(1 days);
        handler.refund(1);
        handler.withdraw(3, 0, false); // recipient of the settled challenge
        handler.withdraw(1, 0, true); // publisher of the refunded challenge, withdrawTo
        assertEq(handler.ghostCreated(), 2);
        assertEq(handler.ghostCommitted(), 2);
        assertEq(handler.ghostSettled(), 1);
        assertEq(handler.ghostRefunded(), 1);
        assertEq(handler.ghostWithdrawn(), 2);
        assertEq(address(bounties).balance, 0);
        invariant_BalanceEqualsEscrowPlusCredits();
        invariant_CreditsSumToTotalCredits();
        invariant_EscrowEqualsFundedRewards();
    }
}

// =================================================================================================
// Hostile / awkward recipients
// =================================================================================================

contract ReentrantRecipient {
    CounterProofBounties internal immutable bounties;
    uint256 public receiveCount;
    bytes public withdrawReentryError;
    bytes public withdrawToReentryError;

    constructor(CounterProofBounties b) {
        bounties = b;
    }

    function pull() external {
        bounties.withdraw();
    }

    receive() external payable {
        ++receiveCount;
        try bounties.withdraw() {}
        catch (bytes memory err) {
            withdrawReentryError = err;
        }
        try bounties.withdrawTo(payable(address(this))) {}
        catch (bytes memory err) {
            withdrawToReentryError = err;
        }
    }
}

contract RevertingRecipient {
    CounterProofBounties internal immutable bounties;

    error NoEtherAccepted();

    constructor(CounterProofBounties b) {
        bounties = b;
    }

    function pull() external {
        bounties.withdraw();
    }

    function pullTo(address payable to) external {
        bounties.withdrawTo(to);
    }

    receive() external payable {
        revert NoEtherAccepted();
    }
}
