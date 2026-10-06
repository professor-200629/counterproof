# CounterProof contracts

`src/CounterProofBounties.sol` is a small escrow for funded red-team challenges. Judging is done by an evaluator, not by the contract.

- A **publisher** funds a challenge with native MON and names an **evaluator**. The terms cannot be changed after creation: there are no setters and no cancel.
- A **challenger** commits a digest of a candidate before the submission deadline. The commit also fixes the **recipient** of any payout.
- The evaluator checks candidates off-chain. For a verified violation it signs an EIP-712 `Attestation`.
- **Anyone** may call `settle`. The reward is credited to the recipient fixed at commit time, never to the caller, so copying the transaction cannot redirect the payout.
- Payouts are pull payments: `withdraw()` or `withdrawTo(address)`. If nobody settles before the settlement deadline, anyone may call `refund` after it, which credits the publisher.

Trust model:
- The evaluator is a declared, trusted party. A signature is an **attestation, not a proof**. The contract checks the signature and the settlement conditions only; it does not check AI behaviour.
- Each challenge pays **one reward**, and the **first eligible settlement wins**.
- Residual risk: whoever holds the evaluator key, including an attacker who steals it, can pay out any committed submission of that challenge before the settlement deadline.

The contract has no tokens, staking, slashing, governance, upgradeability or admin roles.

## Layout

| Path | What |
| --- | --- |
| `src/CounterProofBounties.sol` | The contract (OpenZeppelin v5.6.1 `EIP712`, `ECDSA`, `ReentrancyGuardTransient`) |
| `test/CounterProofBounties.t.sol` | Unit tests, a stateless fuzz test, a stateful invariant suite (handler), and a pinned eth-account EIP-712 vector |
| `test/DependencyPins.t.sol` | Fails the suite when `lib/` holds a different OpenZeppelin or forge-std release |
| `script/Deploy.s.sol` | Deploy script. Reads `DEPLOYER_PRIVATE_KEY` from the environment and never logs it |
| `script/check-release.sh` | Pre-commit / pre-deploy check: submodule pins match `foundry.lock`, and this README never types a key on the command line |
| `foundry.toml` | solc 0.8.31, `evm_version = "osaka"`, `network = "monad"`, optimizer 200 runs, settings for verification, 512 fuzz runs, read access to the two library `package.json` files |
| `foundry.lock` | The pinned library releases: forge-std v1.17.0 (`f3dae6e`), openzeppelin-contracts v5.6.1 (`5fd1781`) |

## Prerequisites

- Foundry 1.8 or later (tested with forge/anvil/cast **1.8.5**). Monad support is built in through `network = "monad"` and `anvil --network monad`.
  On this machine Foundry is not on `PATH`. Use `C:/Users/Balu/.foundry/bin/forge.exe` (and `anvil.exe`, `cast.exe`), or add that folder to `PATH`.
- The dependencies are git submodules under `lib/`: forge-std v1.17.0 and openzeppelin-contracts v5.6.1. After a fresh clone, fetch them and check the pins:

```sh
git submodule update --init          # from the repo root; checks out the commits git records for lib/
cd contracts
bash script/check-release.sh         # must end with "check-release: all checks passed"
```

`git submodule update` follows the commits recorded in git (the gitlinks), not `foundry.lock`. A wrong gitlink still compiles and passes the behaviour tests, but against other library code, so the bytecode differs and Sourcify verification of a deployment fails. `check-release.sh` compares the gitlinks and the checked-out commits with `foundry.lock`, and `test/DependencyPins.t.sol` makes `forge test` fail on a different release. If a submodule is checked out at the wrong commit, `forge install` (no arguments) checks out the `foundry.lock` revisions (tested with forge 1.8.5).
`--recursive` is not needed: the build uses only `lib/openzeppelin-contracts/contracts`, not OpenZeppelin's own test submodules.

Run `bash script/check-release.sh` again before every commit that touches `contracts/` and before every deploy. After `forge install` or `forge update`, stage the new pins with `git add contracts/lib/<name>` from the repo root, or the next commit keeps the old ones.

All commands below run from `contracts/`.

## Build and test

```sh
forge build
forge test -vv
```

`forge test -vv` runs 58 tests:
- the unit tests;
- the two dependency-pin tests;
- `testFuzz_AccountingAcrossLifecycle` with 512 runs;
- the invariant suite, 256 runs x depth 64. It checks that `address(this).balance == totalEscrowed + totalCredits`, that per-account credits sum to `totalCredits`, and that escrow equals the rewards of challenges still Funded.

## Local chain (anvil in Monad mode)

Terminal 1:

```sh
anvil --network monad
```

Terminal 2. Paste one of the private keys that anvil prints at startup when `read` asks for it. These are public dev keys, never real ones. `read -s` does not echo the key, and the key is never part of a command line, so it does not reach the shell history.

```sh
read -rsp 'Deployer key: ' DEPLOYER_PRIVATE_KEY && echo && export DEPLOYER_PRIVATE_KEY
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
unset DEPLOYER_PRIVATE_KEY
```

The script logs the chain id (31337 on local anvil), the deployer address and the contract address. On anvil 1.8.5 in Monad mode, a full create, commit, relayer `settle`, `refund` and `withdrawTo` sequence ran successfully. The transient-storage reentrancy guard works there.

## Monad testnet

- Chain id `10143`
- RPC `https://testnet-rpc.monad.xyz`
- Explorer `https://testnet.monadscan.com/tx/<hash>`

Never type the deployer key on the command line (`export DEPLOYER_PRIVATE_KEY=0x...`, `--private-key 0x...`). An interactive shell saves that line in plain text to its history file (for Git Bash, `~/.bash_history`), and every program started from the shell inherits the variable. Use one of these two options:

```sh
bash script/check-release.sh         # dependency pins must match foundry.lock before you deploy

# Option A: prompt for the key without echo, and drop it afterwards
read -rsp 'Deployer key: ' DEPLOYER_PRIVATE_KEY && echo && export DEPLOYER_PRIVATE_KEY
forge script script/Deploy.s.sol:Deploy --rpc-url https://testnet-rpc.monad.xyz --broadcast
unset DEPLOYER_PRIVATE_KEY
```

Option B: create `contracts/.env` in an editor (not with `echo`, which would also be saved to history) with a single line that sets `DEPLOYER_PRIVATE_KEY` to the key. Forge loads `.env` from the project root on its own, so run the same `forge script` command without the `read` line. `.env` and `.env.*` are git-ignored (`contracts/.gitignore` and the repo root `.gitignore`); `git check-ignore -v contracts/.env` confirms it. Delete the file when you no longer need it.

Verify on Sourcify (Monad's verifier). The `foundry.toml` settings `cbor_metadata = true`, `bytecode_hash = "none"` and `use_literal_content = true` are there for this step. Run verification from the same tree you deployed from, with `check-release.sh` passing. Library sources from any other commit compile to different bytecode and the verification fails.

```sh
forge verify-contract <DEPLOYED_ADDRESS> src/CounterProofBounties.sol:CounterProofBounties \
  --chain 10143 \
  --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/
```

The constructor takes no arguments, so no `--constructor-args` are needed.

### Monad-specific notes

- **Gas is charged on the gas limit, not on the gas used.** Do not pad gas limits more than necessary. By default `forge script` adds 30% on top of its estimate (`--gas-estimate-multiplier 130`). A lower value such as `--gas-estimate-multiplier 110` costs less, but leaves less headroom.
- **10 MON reserve.** A transaction that sends value reverts if the sending EOA would end below 10 MON. `createChallenge` sends the reward as `msg.value`, so the publisher needs at least `reward + gas + 10 MON` before creating a challenge. Payouts from the contract to an EOA (`withdraw` / `withdrawTo`) are not affected.
  Local `anvil --network monad` (1.8.5) did **not** enforce this rule in our check: an 11-ether account sent a 2-ether reward and the transaction succeeded. Test the reserve behaviour on testnet, not on anvil.
- `block.timestamp` is in whole seconds. All deadlines and `expiry` are unix seconds. Every deadline is inclusive (`<=`). A refund is possible only strictly after `settlementDeadline`, so settle and refund are never both available at the same moment.
- The maximum code size is 128 KB. The runtime bytecode here is about 7.3 KB, also under Ethereum's 24 KB limit.

## EIP-712 for the evaluator (signer side)

- Domain: `name = "CounterProof"`, `version = "1"`, `chainId`, `verifyingContract` = the deployed address (no salt).
- Primary type, exact string:

```
Attestation(uint256 challengeId,bytes32 specDigest,bytes32 submissionId,bytes32 candidateDigest,bytes32 evidenceDigest,address challenger,address recipient,uint8 verdict,uint64 expiry)
```

- `verdict` must be `1` (`VERDICT_VERIFIED_VIOLATION`). `evidenceDigest` must be non-zero.
- `submissionId` is `keccak256(abi.encode(chainid, contract, challengeId, challenger, candidateDigest))`. The contract also exposes it as `submissionIdFor(...)`.
- Signatures are 65 bytes (`r || s || v`) with low-s. High-s (malleable) signatures are rejected.
- `hashAttestation(a)` returns the digest to sign, and `domainSeparator()` returns the domain separator. Use both to check an off-chain signer against a deployment.
- `test_PythonEthAccountVectorSettles` pins a vector produced by eth-account 0.14.0 `Account.sign_typed_data`. It uses chain 10143, a fixed contract address and a throwaway test key, and the resulting signature settles a challenge on the contract. If the test breaks, the Python signer and the contract disagree.

Off-chain hygiene: the contract stores only `candidateDigest`. Make it a salted digest so the candidate cannot be guessed. Someone else can commit the same digest under their own address. That gives them a different `submissionId`, and the evaluator's attestation for the original submission does not work for theirs. `committedAt` records which commit came first.

## Custom errors (selectors are in `out/CounterProofBounties.sol/CounterProofBounties.json`)

| Function | Errors |
| --- | --- |
| Create | `ZeroReward`, `ZeroSpecDigest`, `ZeroEvaluator`, `SubmissionDeadlineNotInFuture`, `SubmissionPeriodTooLong`, `SettlementDeadlineNotAfterSubmissionDeadline`, `SettlementWindowTooShort`, `SettlementWindowTooLong` |
| Status (any function) | `ChallengeNotFound`, `AlreadySettled`, `AlreadyRefunded` |
| Commit | `SubmissionPeriodOver`, `ZeroCandidateDigest`, `ZeroRecipient`, `AlreadyCommitted` |
| Settle | `SettlementDeadlinePassed`, `AttestationExpired`, `SpecDigestMismatch`, `VerdictNotViolation`, `UnknownSubmission`, `SubmissionMismatch`, `ZeroEvidenceDigest`, `InvalidSignature(reason)`, `SignerNotEvaluator` |
| Refund | `RefundTooEarly` |
| Withdraw | `NothingToWithdraw`, `TransferFailed`, `ZeroRecipient` |
| Reentrancy (from OpenZeppelin) | `ReentrancyGuardReentrantCall` |
