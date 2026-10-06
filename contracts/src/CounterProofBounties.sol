// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title CounterProofBounties
/// @notice Minimal escrow for funded red-team challenges with evaluator-mediated adjudication.
///
/// Flow: a publisher funds a challenge and names an evaluator. Challengers commit a digest of their
/// candidate (and the recipient of any payout) before the submission deadline. The evaluator checks
/// candidates off-chain and signs an EIP-712 `Attestation` for one that shows a verified violation.
/// Anyone may submit that attestation; the reward is credited to the recipient bound at commit time
/// and withdrawn later (pull payment). If nobody settles before the settlement deadline, anyone may
/// trigger a refund that credits the publisher.
///
/// Trust model, stated plainly:
/// - The evaluator is a declared, trusted party chosen by the publisher. Challengers must decide for
///   themselves whether they trust it. The publisher may name itself as evaluator.
/// - An evaluator signature is an attestation, not a proof. This contract checks the signature and the
///   settlement conditions only; it does NOT verify AI behaviour, the candidate, or the evidence.
/// - One reward per challenge. The first eligible settlement accepted on-chain wins; every later
///   attestation for the same challenge reverts, even if it is validly signed.
/// - Residual risk: whoever holds the evaluator key (including an attacker after a key compromise) can
///   pay out any committed submission of that challenge before the settlement deadline. The payout
///   still only goes to the recipient that the submission's challenger bound at commit time.
///
/// Other properties: challenge terms are immutable once created (no setters, no cancel); there are no
/// tokens, staking, slashing, governance, upgradeability or admin roles. Only ECDSA (EOA) evaluator
/// keys are supported. Ether sent to this contract by any route other than `createChallenge` (for
/// example a forced send) is not accounted for and cannot be recovered.
contract CounterProofBounties is EIP712, ReentrancyGuardTransient {
    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    enum Status {
        None,
        Funded,
        Settled,
        Refunded
    }

    struct Challenge {
        address publisher;
        address evaluator;
        uint64 submissionDeadline;
        uint64 settlementDeadline;
        Status status;
        uint256 reward;
        bytes32 specDigest;
        bytes32 settledSubmission;
    }

    struct Submission {
        uint256 challengeId;
        address challenger;
        address recipient;
        uint64 committedAt;
        bytes32 candidateDigest;
    }

    struct Attestation {
        uint256 challengeId;
        bytes32 specDigest;
        bytes32 submissionId;
        bytes32 candidateDigest;
        bytes32 evidenceDigest;
        address challenger;
        address recipient;
        uint8 verdict;
        uint64 expiry;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------------------

    /// @notice The only verdict that can settle a challenge.
    uint8 public constant VERDICT_VERIFIED_VIOLATION = 1;

    /// @notice EIP-712 type hash. Off-chain signers depend on this exact string.
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 challengeId,bytes32 specDigest,bytes32 submissionId,bytes32 candidateDigest,bytes32 evidenceDigest,address challenger,address recipient,uint8 verdict,uint64 expiry)"
    );

    uint256 public constant MIN_SETTLEMENT_WINDOW = 5 minutes;
    uint256 public constant MAX_SETTLEMENT_WINDOW = 30 days;
    uint256 public constant MAX_SUBMISSION_PERIOD = 90 days;

    // ---------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------

    uint256 public challengeCount;
    mapping(uint256 challengeId => Challenge) private challenges;
    mapping(bytes32 submissionId => Submission) private submissions;
    mapping(address account => uint256 amount) public credits;

    /// @notice Ether held for challenges that are still Funded.
    uint256 public totalEscrowed;
    /// @notice Ether credited to accounts and not yet withdrawn.
    uint256 public totalCredits;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event ChallengeCreated(
        uint256 indexed challengeId,
        address indexed publisher,
        address indexed evaluator,
        bytes32 specDigest,
        uint256 reward,
        uint64 submissionDeadline,
        uint64 settlementDeadline
    );

    event SubmissionCommitted(
        uint256 indexed challengeId,
        bytes32 indexed submissionId,
        address indexed challenger,
        address recipient,
        bytes32 candidateDigest
    );

    event ChallengeSettled(
        uint256 indexed challengeId,
        bytes32 indexed submissionId,
        address indexed recipient,
        uint256 reward,
        bytes32 evidenceDigest
    );

    event ChallengeRefunded(uint256 indexed challengeId, address indexed publisher, uint256 reward);

    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    // createChallenge
    error ZeroReward();
    error ZeroSpecDigest();
    error ZeroEvaluator();
    error SubmissionDeadlineNotInFuture(uint64 submissionDeadline, uint256 nowTimestamp);
    error SubmissionPeriodTooLong(uint256 period, uint256 maxPeriod);
    error SettlementDeadlineNotAfterSubmissionDeadline(uint64 submissionDeadline, uint64 settlementDeadline);
    error SettlementWindowTooShort(uint256 window, uint256 minWindow);
    error SettlementWindowTooLong(uint256 window, uint256 maxWindow);

    // challenge status (shared)
    error ChallengeNotFound(uint256 challengeId);
    error AlreadySettled(uint256 challengeId);
    /// @dev Named `AlreadyRefunded` because `ChallengeRefunded` is the event name.
    error AlreadyRefunded(uint256 challengeId);

    // commitSubmission
    error SubmissionPeriodOver(uint256 challengeId, uint64 submissionDeadline);
    error ZeroCandidateDigest();
    error ZeroRecipient();
    error AlreadyCommitted(bytes32 submissionId);

    // settle
    error SettlementDeadlinePassed(uint256 challengeId, uint64 settlementDeadline);
    error AttestationExpired(uint64 expiry);
    error SpecDigestMismatch(bytes32 expected, bytes32 provided);
    error VerdictNotViolation(uint8 verdict);
    error UnknownSubmission(bytes32 submissionId);
    error SubmissionMismatch(bytes32 submissionId);
    error ZeroEvidenceDigest();
    error InvalidSignature(ECDSA.RecoverError reason);
    error SignerNotEvaluator(address recovered, address evaluator);

    // refund
    error RefundTooEarly(uint256 challengeId, uint64 settlementDeadline);

    // withdraw
    error NothingToWithdraw();
    error TransferFailed(address to, uint256 amount);

    // ---------------------------------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------------------------------

    constructor() EIP712("CounterProof", "1") {}

    // ---------------------------------------------------------------------------------------------
    // Publisher
    // ---------------------------------------------------------------------------------------------

    /// @notice Fund a new challenge. `msg.value` is the single reward. Terms cannot be changed later.
    /// @param specDigest Digest of the off-chain challenge specification.
    /// @param evaluator Address whose EIP-712 signature can settle this challenge.
    /// @param submissionDeadline Last timestamp (inclusive) at which submissions can be committed.
    /// @param settlementDeadline Last timestamp (inclusive) at which the challenge can be settled.
    function createChallenge(
        bytes32 specDigest,
        address evaluator,
        uint64 submissionDeadline,
        uint64 settlementDeadline
    ) external payable returns (uint256 challengeId) {
        if (msg.value == 0) revert ZeroReward();
        if (specDigest == bytes32(0)) revert ZeroSpecDigest();
        if (evaluator == address(0)) revert ZeroEvaluator();
        if (submissionDeadline <= block.timestamp) {
            revert SubmissionDeadlineNotInFuture(submissionDeadline, block.timestamp);
        }
        uint256 period = submissionDeadline - block.timestamp;
        if (period > MAX_SUBMISSION_PERIOD) revert SubmissionPeriodTooLong(period, MAX_SUBMISSION_PERIOD);
        if (settlementDeadline <= submissionDeadline) {
            revert SettlementDeadlineNotAfterSubmissionDeadline(submissionDeadline, settlementDeadline);
        }
        uint256 window = settlementDeadline - submissionDeadline;
        if (window < MIN_SETTLEMENT_WINDOW) revert SettlementWindowTooShort(window, MIN_SETTLEMENT_WINDOW);
        if (window > MAX_SETTLEMENT_WINDOW) revert SettlementWindowTooLong(window, MAX_SETTLEMENT_WINDOW);

        challengeId = ++challengeCount;
        challenges[challengeId] = Challenge({
            publisher: msg.sender,
            evaluator: evaluator,
            submissionDeadline: submissionDeadline,
            settlementDeadline: settlementDeadline,
            status: Status.Funded,
            reward: msg.value,
            specDigest: specDigest,
            settledSubmission: bytes32(0)
        });
        totalEscrowed += msg.value;

        emit ChallengeCreated(
            challengeId, msg.sender, evaluator, specDigest, msg.value, submissionDeadline, settlementDeadline
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Challenger
    // ---------------------------------------------------------------------------------------------

    /// @notice Deterministic id of a submission. Binds chain id and this contract's address.
    function submissionIdFor(uint256 challengeId, address challenger, bytes32 candidateDigest)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), challengeId, challenger, candidateDigest));
    }

    /// @notice Commit a candidate digest for a funded challenge. The caller is the challenger.
    /// @param recipient Address that will be credited if this submission settles. Fixed forever.
    function commitSubmission(uint256 challengeId, bytes32 candidateDigest, address recipient)
        external
        returns (bytes32 submissionId)
    {
        Challenge storage c = challenges[challengeId];
        _requireFunded(challengeId, c.status);
        if (block.timestamp > c.submissionDeadline) revert SubmissionPeriodOver(challengeId, c.submissionDeadline);
        if (candidateDigest == bytes32(0)) revert ZeroCandidateDigest();
        if (recipient == address(0)) revert ZeroRecipient();

        submissionId = submissionIdFor(challengeId, msg.sender, candidateDigest);
        if (submissions[submissionId].challenger != address(0)) revert AlreadyCommitted(submissionId);

        submissions[submissionId] = Submission({
            challengeId: challengeId,
            challenger: msg.sender,
            recipient: recipient,
            // forge-lint: disable-next-line(unsafe-typecast) -- uint64 seconds overflow in ~5.8e11 years.
            committedAt: uint64(block.timestamp),
            candidateDigest: candidateDigest
        });

        emit SubmissionCommitted(challengeId, submissionId, msg.sender, recipient, candidateDigest);
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement (anyone may relay)
    // ---------------------------------------------------------------------------------------------

    /// @notice Settle a challenge with the evaluator's EIP-712 attestation. Callable by anyone.
    /// @dev The reward is credited to the recipient bound at commit time, never to `msg.sender`, so a
    ///      front-runner who copies the calldata cannot redirect it. No external call is made here.
    function settle(Attestation calldata a, bytes calldata signature) external nonReentrant {
        Challenge storage c = challenges[a.challengeId];
        _requireFunded(a.challengeId, c.status);
        if (block.timestamp > c.settlementDeadline) {
            revert SettlementDeadlinePassed(a.challengeId, c.settlementDeadline);
        }
        if (block.timestamp > a.expiry) revert AttestationExpired(a.expiry);
        if (a.specDigest != c.specDigest) revert SpecDigestMismatch(c.specDigest, a.specDigest);
        if (a.verdict != VERDICT_VERIFIED_VIOLATION) revert VerdictNotViolation(a.verdict);

        Submission storage s = submissions[a.submissionId];
        if (s.challenger == address(0)) revert UnknownSubmission(a.submissionId);
        if (
            s.challengeId != a.challengeId || s.challenger != a.challenger || s.recipient != a.recipient
                || s.candidateDigest != a.candidateDigest
        ) revert SubmissionMismatch(a.submissionId);
        if (a.evidenceDigest == bytes32(0)) revert ZeroEvidenceDigest();

        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hashAttestation(a), signature);
        if (err != ECDSA.RecoverError.NoError) revert InvalidSignature(err);
        if (recovered != c.evaluator) revert SignerNotEvaluator(recovered, c.evaluator);

        uint256 reward = c.reward;
        address recipient = s.recipient;
        c.status = Status.Settled;
        c.settledSubmission = a.submissionId;
        credits[recipient] += reward;
        totalEscrowed -= reward;
        totalCredits += reward;

        // forge-lint: disable-next-line(reentrancy-events) -- the only "call" above is the ecrecover precompile.
        emit ChallengeSettled(a.challengeId, a.submissionId, recipient, reward, a.evidenceDigest);
    }

    /// @notice Return an unsettled reward to the publisher's credits. Anyone may trigger it, but only
    ///         once the settlement deadline has passed (strictly after it).
    function refund(uint256 challengeId) external nonReentrant {
        Challenge storage c = challenges[challengeId];
        _requireFunded(challengeId, c.status);
        if (block.timestamp <= c.settlementDeadline) revert RefundTooEarly(challengeId, c.settlementDeadline);

        uint256 reward = c.reward;
        address publisher = c.publisher;
        c.status = Status.Refunded;
        credits[publisher] += reward;
        totalEscrowed -= reward;
        totalCredits += reward;

        emit ChallengeRefunded(challengeId, publisher, reward);
    }

    // ---------------------------------------------------------------------------------------------
    // Withdrawals (pull payments)
    // ---------------------------------------------------------------------------------------------

    /// @notice Withdraw all of the caller's credits to the caller.
    function withdraw() external nonReentrant {
        _withdraw(payable(msg.sender));
    }

    /// @notice Withdraw all of the caller's credits to `to`. Useful when the caller cannot receive ether.
    function withdrawTo(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroRecipient();
        _withdraw(to);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function getChallenge(uint256 challengeId) external view returns (Challenge memory) {
        return challenges[challengeId];
    }

    function getSubmission(bytes32 submissionId) external view returns (Submission memory) {
        return submissions[submissionId];
    }

    /// @notice The EIP-712 digest the evaluator signs for `a` on this chain and this contract.
    function hashAttestation(Attestation calldata a) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
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
        return _hashTypedDataV4(structHash);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _requireFunded(uint256 challengeId, Status status) private pure {
        if (status == Status.Funded) return;
        if (status == Status.None) revert ChallengeNotFound(challengeId);
        if (status == Status.Settled) revert AlreadySettled(challengeId);
        revert AlreadyRefunded(challengeId);
    }

    function _withdraw(address payable to) private {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Effects before the interaction. A failed transfer reverts the whole call, which restores
        // the credit, so a recipient that cannot receive ether keeps its balance.
        credits[msg.sender] = 0;
        totalCredits -= amount;
        emit Withdrawn(msg.sender, to, amount);

        // forge-lint: disable-next-line(arbitrary-send-eth) -- sends only the caller's own credit, to where it asks.
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }
}
