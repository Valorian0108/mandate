// GateAccount v0.3 — user-owned Starknet smart account enforcing AI-agent spending policy.
// Architecture: OpenZeppelin v4.0.1 AccountComponent (owner auth) + custom session-key /
// spending enforcement following the Session Keys SNIP (chipi-pay) specification.
// v0.3 adds CONTROLLER-BOUND SNIP-9 outside execution: the owner's signing identity may be
// a native wallet (Argent X / Braavos) registered on-chain as `wallet_controller`. The
// SNIP-12 hash binds to THAT address — a wallet always hashes typed data with its own
// address (starknet.js Account.signMessage → Signer.signMessage; a dapp cannot override
// it), so a plain SRC9Component embed would reject every wallet signature forever.
// Verification is delegated to the controller's is_valid_signature; caller binding,
// time window and one-shot nonces stay in GateAccount. See track2-wallet-research.md.
// v0.3 also adds an owner-gated `upgrade` (UpgradeableComponent): v0.2 had no upgrade
// path, which is why v0.3 itself needs a fresh deploy_account — from v0.3 on, upgrades
// are in-place owner-signed actions like any other.
// v0.4 (OBS-32/33): the owner-level admin entrypoints (upgrade, controller
// registration, session keys, spending policy, recipient allowlist) accept the gate
// itself OR the registered wallet controller. Ready X rehearses a SNIP-9 message's
// calls FROM THE WALLET at signing time; a self-only guard can never pass that
// rehearsal, so no native wallet could ever sign a genuine admin authorization — the
// wallet's safety model and the guard model contradicted each other. The controller IS
// the owner's signing identity (see the execute_from_outside_v2 doctrine), so admitting
// it as a caller adds no privilege its signature does not already carry, and makes the
// rehearsal truthful: a genuine authorization passes, every other caller still hits the
// pinned 'Account: unauthorized' panic.
// See DESIGN.md for decisions and test plan.

pub mod mocks;
pub mod evidence_registry;

#[derive(Drop, Copy, Serde, Debug, PartialEq, starknet::Store)]
pub struct SessionData {
    pub valid_until: u64,
    pub max_calls: u32,
    pub calls_used: u32,
    pub allowed_entrypoints_len: u32,
}

#[derive(Drop, Copy, Serde, Debug, PartialEq, starknet::Store)]
pub struct SpendingPolicy {
    pub max_per_call: u256,
    pub max_per_window: u256,
    pub window_seconds: u64,
    pub spent_in_window: u256,
    pub window_start: u64,
}

#[starknet::interface]
pub trait ISessionKeyManager<TContractState> {
    fn add_or_update_session_key(
        ref self: TContractState,
        session_key: felt252,
        valid_until: u64,
        max_calls: u32,
        allowed_entrypoints: Array<felt252>,
    );
    fn revoke_session_key(ref self: TContractState, session_key: felt252);
    fn get_session_data(self: @TContractState, session_key: felt252) -> SessionData;
}

#[starknet::interface]
pub trait IGateSpendingPolicy<TContractState> {
    fn set_spending_policy(
        ref self: TContractState,
        session_key: felt252,
        token: starknet::ContractAddress,
        max_per_call: u256,
        max_per_window: u256,
        window_seconds: u64,
    );
    fn remove_spending_policy(
        ref self: TContractState,
        session_key: felt252,
        token: starknet::ContractAddress,
    );
    fn get_spending_policy(
        self: @TContractState,
        session_key: felt252,
        token: starknet::ContractAddress,
    ) -> SpendingPolicy;
    // v0.2 recipient allowlist: per (session, token), deny-by-default.
    fn allow_recipient(
        ref self: TContractState,
        session_key: felt252,
        token: starknet::ContractAddress,
        recipient: starknet::ContractAddress,
    );
    fn disallow_recipient(
        ref self: TContractState,
        session_key: felt252,
        token: starknet::ContractAddress,
        recipient: starknet::ContractAddress,
    );
    fn is_recipient_allowed(
        self: @TContractState,
        session_key: felt252,
        token: starknet::ContractAddress,
        recipient: starknet::ContractAddress,
    ) -> bool;
}

#[starknet::interface]
pub trait IWalletController<TContractState> {
    // v0.3 (SNIP-9): register the address whose `is_valid_signature` validates
    // execute_from_outside_v2 signatures. Owner-level twice over: self-or-controller
    // (v0.4) AND the session admin blocklist. Zero = unregistered = outside execution
    // refuses everything. Registering this account's own address makes the owner key
    // itself the controller (a plain EOA-style signer verifies via our is_valid_signature).
    fn set_wallet_controller(ref self: TContractState, controller: starknet::ContractAddress);
    fn get_wallet_controller(self: @TContractState) -> starknet::ContractAddress;
}

#[starknet::contract(account)]
pub mod GateAccount {
    use openzeppelin::account::AccountComponent;
    use openzeppelin::account::extensions::src9::snip12_utils::OutsideExecutionStructHash;
    use openzeppelin::account::utils::is_tx_version_valid;
    use openzeppelin::interfaces::src9::{ISRC9_V2, ISRC9_V2_ID, OutsideExecution};
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::upgrades::UpgradeableComponent;
    use openzeppelin::upgrades::UpgradeableComponent::InternalTrait as UpgradeableInternalTrait;
    use openzeppelin::utils::cryptography::snip12::{
        SNIP12Metadata, StarknetDomain, StructHash, StructHashStarknetDomainImpl,
    };
    use openzeppelin::utils::execution::{assert_valid_signature, execute_calls};
    use starknet::account::Call;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ClassHash, ContractAddress};
    use core::ecdsa::check_ecdsa_signature;
    use core::hash::{HashStateExTrait, HashStateTrait};
    use core::poseidon::{PoseidonTrait, poseidon_hash_span};
    use super::{
        IGateSpendingPolicy, ISessionKeyManager, IWalletController, SessionData, SpendingPolicy,
    };

    component!(path: AccountComponent, storage: account, event: AccountEvent);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: UpgradeableComponent, storage: upgradeable, event: UpgradeableEvent);

    // Public ABI pieces from OpenZeppelin: key management, deploy-account validation,
    // camelCase signature check, SRC-5 introspection. __execute__ / __validate__ /
    // __validate_declare__ are implemented manually below (AccountContract trait) so
    // session-key signatures get policy enforcement.
    #[abi(embed_v0)]
    impl PublicKeyImpl = AccountComponent::PublicKeyImpl<ContractState>;
    #[abi(embed_v0)]
    impl PublicKeyCamelImpl = AccountComponent::PublicKeyCamelImpl<ContractState>;
    #[abi(embed_v0)]
    impl DeployableImpl = AccountComponent::DeployableImpl<ContractState>;
    #[abi(embed_v0)]
    impl SRC6CamelOnlyImpl = AccountComponent::SRC6CamelOnlyImpl<ContractState>;
    #[abi(embed_v0)]
    impl SRC5Impl = SRC5Component::SRC5Impl<ContractState>;

    impl AccountInternalImpl = AccountComponent::InternalImpl<ContractState>;
    impl SRC5InternalImpl = SRC5Component::InternalImpl<ContractState>;
    impl UpgradeableInternalImpl = UpgradeableComponent::InternalImpl<ContractState>;

    // Entry-point selectors (compile-time constants).
    const SEL_UPGRADE: felt252 = selector!("upgrade");
    const SEL_EXECUTE: felt252 = selector!("__execute__");
    const SEL_VALIDATE_DECLARE: felt252 = selector!("__validate_declare__");
    const SEL_VALIDATE_DEPLOY: felt252 = selector!("__validate_deploy__");
    const SEL_SET_PUBLIC_KEY: felt252 = selector!("set_public_key");
    const SEL_SET_PUBLIC_KEY_CAMEL: felt252 = selector!("setPublicKey");
    const SEL_EXECUTE_FROM_OUTSIDE_V2: felt252 = selector!("execute_from_outside_v2");
    const SEL_ADD_SESSION: felt252 = selector!("add_or_update_session_key");
    const SEL_REVOKE_SESSION: felt252 = selector!("revoke_session_key");
    const SEL_GET_SESSION: felt252 = selector!("get_session_data");
    const SEL_SET_SPENDING: felt252 = selector!("set_spending_policy");
    const SEL_REMOVE_SPENDING: felt252 = selector!("remove_spending_policy");
    const SEL_ALLOW_RECIPIENT: felt252 = selector!("allow_recipient");
    const SEL_DISALLOW_RECIPIENT: felt252 = selector!("disallow_recipient");
    const SEL_SET_WALLET_CONTROLLER: felt252 = selector!("set_wallet_controller");

    // ERC-20 selectors that move value or grant allowances (SNIP Part H tracked set).
    const SEL_TRANSFER: felt252 = selector!("transfer");
    const SEL_APPROVE: felt252 = selector!("approve");
    const SEL_INCREASE_ALLOWANCE: felt252 = selector!("increase_allowance");
    const SEL_INCREASE_ALLOWANCE_CAMEL: felt252 = selector!("increaseAllowance");

    #[storage]
    struct Storage {
        #[substorage(v0)]
        account: AccountComponent::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        upgradeable: UpgradeableComponent::Storage,
        sessions: Map<felt252, SessionData>,
        session_entrypoints: Map<(felt252, u32), felt252>,
        spending: Map<(felt252, ContractAddress), SpendingPolicy>,
        // v0.2: (session_key, token, recipient) -> allowed. Absence means denied.
        recipients: Map<(felt252, ContractAddress, ContractAddress), bool>,
        // v0.3 (SNIP-9): the address whose is_valid_signature validates outside
        // executions. Zero (default) = unregistered = every outside execution refused.
        wallet_controller: ContractAddress,
        // v0.3: one-shot nonces for execute_from_outside_v2 (SRC9 semantics).
        outside_nonces: Map<felt252, bool>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        AccountEvent: AccountComponent::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        UpgradeableEvent: UpgradeableComponent::Event,
        SessionKeyAdded: SessionKeyAdded,
        SessionKeyRevoked: SessionKeyRevoked,
        SpendingPolicySet: SpendingPolicySet,
        SpendingPolicyRemoved: SpendingPolicyRemoved,
        RecipientAllowed: RecipientAllowed,
        RecipientDisallowed: RecipientDisallowed,
        WalletControllerSet: WalletControllerSet,
    }

    #[derive(Drop, starknet::Event)]
    struct WalletControllerSet {
        #[key]
        controller: ContractAddress,
        previous: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct SessionKeyAdded {
        #[key]
        session_key: felt252,
        valid_until: u64,
        max_calls: u32,
    }

    #[derive(Drop, starknet::Event)]
    struct SessionKeyRevoked {
        #[key]
        session_key: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct SpendingPolicySet {
        #[key]
        session_key: felt252,
        #[key]
        token: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct SpendingPolicyRemoved {
        #[key]
        session_key: felt252,
        #[key]
        token: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct RecipientAllowed {
        #[key]
        session_key: felt252,
        #[key]
        token: ContractAddress,
        #[key]
        recipient: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct RecipientDisallowed {
        #[key]
        session_key: felt252,
        #[key]
        token: ContractAddress,
        #[key]
        recipient: ContractAddress,
    }

    #[constructor]
    fn constructor(ref self: ContractState, public_key: felt252) {
        // Registers ISRC6 in SRC-5 and stores the owner key.
        self.account.initializer(public_key);
        // SRC-5 id of ISessionKeyManager = XOR of its function selectors (SNIP rule).
        self.src5.register_interface(xor3(SEL_ADD_SESSION, SEL_REVOKE_SESSION, SEL_GET_SESSION));
        // v0.3: advertise SNIP-9 v2. The id is imported from the OZ artifact — never
        // retyped from memory (house rule; drift is a compile error, not a silent lie).
        self.src5.register_interface(ISRC9_V2_ID);
    }

    // ------------------------------------------------------------------
    // Account entry points (SNIP-6 standard trait, mutable self)
    // ------------------------------------------------------------------
    #[abi(embed_v0)]
    impl GateAccountImpl of starknet::account::AccountContract<ContractState> {
        fn __validate_declare__(self: @ContractState, class_hash: felt252) -> felt252 {
            // Declares are owner-only (standard 2-element signature over the tx hash).
            self.account.validate_transaction()
        }

        fn __validate__(ref self: ContractState, calls: Array<Call>) -> felt252 {
            let tx_info = starknet::get_tx_info().unbox();
            if tx_info.signature.len() == 4 {
                // Agent session path: [session_pubkey, r, s, valid_until].
                self
                    .validate_session(
                        calls.span(), tx_info.signature, tx_info.chain_id, tx_info.nonce,
                    )
            } else {
                // Owner path: standard OpenZeppelin ECDSA validation of the tx hash.
                self.account.validate_transaction()
            }
        }

        fn __execute__(ref self: ContractState, calls: Array<Call>) -> Array<Span<felt252>> {
            // Protocol-mandated safety checks (missing these can drain the account).
            let caller: felt252 = starknet::get_caller_address().into();
            assert!(caller == 0, "GateAccount: caller is not the protocol");
            assert!(is_tx_version_valid(), "GateAccount: invalid tx version");

            let tx_info = starknet::get_tx_info().unbox();
            if tx_info.signature.len() == 4 {
                let session_key = *tx_info.signature.at(0);
                // SNIP step 8: budget consumption + spending caps happen AFTER validation,
                // in __execute__, because state changes in __validate__ are discarded.
                self.consume_session_call(session_key);
                self.enforce_spending(calls.span(), session_key);
            }

            execute_calls(calls.span())
        }
    }

    #[external(v0)]
    fn is_valid_signature(
        self: @ContractState, hash: felt252, signature: Array<felt252>,
    ) -> felt252 {
        // Message signing is owner-only: session keys are deliberately NOT signers
        // (SNIP tradeoff — is_valid_signature has no call context, so selector
        // whitelists could not be enforced there).
        if self.account._is_valid_signature(hash, signature.span()) {
            starknet::VALIDATED
        } else {
            0
        }
    }

    #[generate_trait]
    impl OwnerLevelGuard of OwnerLevelGuardTrait {
        // The owner paths (__execute__ with an owner signature, and controller-bound
        // SNIP-9 outside execution) run admin calls with caller == this account. v0.4
        // additionally admits the registered wallet controller as a DIRECT caller: the
        // controller IS the owner's signing identity (see the execute_from_outside_v2
        // doctrine), so this adds no privilege the controller's signature does not
        // already carry — and it is the only guard a native wallet's signing rehearsal
        // can represent (OBS-32): Ready X replays an authorization's calls FROM THE
        // WALLET, so a self-only guard fails that rehearsal forever, freezing every
        // wallet-signed admin action. The panic stays the OZ felt252 short string
        // 'Account: unauthorized' — tests/lib.cairo pins that exact felt tuple for
        // every outsider (t30/t33/t41), so this panics with panic_with_felt252 on
        // purpose: `assert!` would emit a ByteArray panic, same words, different
        // bytes, and the pins would break (they did, loudly, before this fix).
        fn assert_only_self_or_controller(self: @ContractState) {
            let caller = starknet::get_caller_address();
            if caller == starknet::get_contract_address() {
                return;
            }
            let controller = self.wallet_controller.read();
            if caller != controller {
                core::panic_with_felt252('Account: unauthorized');
            }
        }
    }

    // ------------------------------------------------------------------
    // v0.3: owner-gated in-place upgrade (UpgradeableComponent)
    // ------------------------------------------------------------------
    // v0.2 had no upgrade entry point — that is why v0.3 needs a fresh
    // deploy_account. From v0.3 on, an upgrade is an owner-signed action like any
    // other (sessions are blocked twice: the owner-level guard here, and `upgrade`
    // is an admin selector). v0.4: the guard admits the registered controller too,
    // so a native wallet can carry its own upgrade — the rehearsal passes exactly
    // when the caller is the owner's signing identity (OBS-32/33).
    #[external(v0)]
    fn upgrade(ref self: ContractState, new_class_hash: ClassHash) {
        self.assert_only_self_or_controller();
        self.upgradeable.upgrade(new_class_hash);
    }

    // ------------------------------------------------------------------
    // v0.3: SNIP-9 wallet controller registration (owner-level: self or controller, v0.4)
    // ------------------------------------------------------------------
    #[abi(embed_v0)]
    impl WalletControllerImpl of IWalletController<ContractState> {
        fn set_wallet_controller(ref self: ContractState, controller: ContractAddress) {
            self.assert_only_self_or_controller();
            let previous = self.wallet_controller.read();
            self.wallet_controller.write(controller);
            self.emit(WalletControllerSet { controller, previous });
        }

        fn get_wallet_controller(self: @ContractState) -> ContractAddress {
            self.wallet_controller.read()
        }
    }

    // ------------------------------------------------------------------
    // v0.3: SNIP-9 outside execution, CONTROLLER-BOUND
    // ------------------------------------------------------------------
    // Same shape as OZ's SRC9Component (caller binding, exclusive time window,
    // one-shot nonce, signature check, execute) with ONE deliberate deviation: the
    // SNIP-12 hash binds to the owner-registered `wallet_controller` address instead
    // of this contract's address, and verification is delegated to that controller's
    // is_valid_signature. Reason (binding finding, track2-wallet-research.md): a
    // native wallet always hashes typed data with its OWN address — a dapp cannot
    // override it — so a plain SRC9 embed would reject every wallet signature
    // forever. With the controller registered as the wallet's address, the wallet's
    // own signature validates; with the controller set to this account's address, a
    // plain EOA-style key (the pasted testnet key) validates via our own owner-only
    // is_valid_signature. Deny by default: no controller registered = everything
    // refused.
    #[abi(embed_v0)]
    impl GateOutsideExecutionImpl of ISRC9_V2<ContractState> {
        fn execute_from_outside_v2(
            ref self: ContractState,
            outside_execution: OutsideExecution,
            signature: Span<felt252>,
        ) -> Array<Span<felt252>> {
            // Caller binding: 'ANY_CALLER' shortstring, or exactly the signed caller.
            // Error strings are ByteArrays (house style, matches v0.1/v0.2 asserts);
            // the ONE felt-string error is 'GateAccount: invalid signature' because
            // OZ's assert_valid_signature takes invalid_signature_error: felt252.
            if outside_execution.caller.into() != 'ANY_CALLER' {
                assert!(
                    starknet::get_caller_address() == outside_execution.caller,
                    "GateAccount: invalid caller",
                );
            }

            // Time window, exclusive bounds (OZ SRC9 semantics).
            let now = starknet::get_block_timestamp();
            assert!(outside_execution.execute_after < now, "GateAccount: too early");
            assert!(now < outside_execution.execute_before, "GateAccount: expired");

            // One-shot nonce (replay protection lives here, never in the controller).
            assert!(
                !self.outside_nonces.read(outside_execution.nonce),
                "GateAccount: duplicated nonce",
            );

            // Controller-bound verification: the hash binds to the controller's
            // address and ONLY the controller's is_valid_signature can validate it.
            let controller = self.wallet_controller.read();
            let zero_address: ContractAddress = 0.try_into().unwrap();
            assert!(controller != zero_address, "GateAccount: no controller");
            let chain_id = starknet::get_tx_info().unbox().chain_id;
            let message_hash =
                outside_execution_message_hash(@outside_execution, controller, chain_id);
            assert_valid_signature(
                controller, message_hash, signature, 'GateAccount: invalid signature',
            );

            // Consume the nonce only for a verified authorization. Inside one tx this
            // is equivalent to OZ's mark-then-verify order (a failed verify reverts
            // the mark); marking last keeps the intent clearer.
            self.outside_nonces.write(outside_execution.nonce, true);

            // Owner-level authority: the controller IS the owner's signing identity,
            // so an outside execution may call whatever the owner may call (the
            // wallet UI shows the owner the exact calls being authorized). Session
            // spending policy is the AGENT mechanism and deliberately does not apply
            // here — matching the owner __execute__ path above.
            execute_calls(outside_execution.calls)
        }

        fn is_valid_outside_execution_nonce(self: @ContractState, nonce: felt252) -> bool {
            !self.outside_nonces.read(nonce)
        }
    }

    // ------------------------------------------------------------------
    // Session key management (owner-level: self or controller, v0.4)
    // ------------------------------------------------------------------
    #[abi(embed_v0)]
    impl SessionKeyManagerImpl of ISessionKeyManager<ContractState> {
        fn add_or_update_session_key(
            ref self: ContractState,
            session_key: felt252,
            valid_until: u64,
            max_calls: u32,
            allowed_entrypoints: Array<felt252>,
        ) {
            self.assert_only_self_or_controller();
            assert!(session_key != 0, "GateAccount: zero session key");
            assert!(max_calls > 0, "GateAccount: zero max calls");

            // Clear stale entrypoint whitelist before writing the new one (SNIP Part E).
            let old = self.sessions.read(session_key);
            let mut i: u32 = 0;
            loop {
                if i >= old.allowed_entrypoints_len {
                    break;
                }
                self.session_entrypoints.write((session_key, i), 0);
                i += 1;
            };

            let entries = allowed_entrypoints.span();
            let new_len: u32 = allowed_entrypoints.len();
            let mut j: u32 = 0;
            loop {
                if j >= new_len {
                    break;
                }
                self.session_entrypoints.write((session_key, j), *entries.at(j));
                j += 1;
            };

            self
                .sessions
                .write(
                    session_key,
                    SessionData {
                        valid_until,
                        max_calls,
                        calls_used: 0, // MUST reset on update (SNIP Part A).
                        allowed_entrypoints_len: new_len,
                    },
                );

            self.emit(SessionKeyAdded { session_key, valid_until, max_calls });
        }

        fn revoke_session_key(ref self: ContractState, session_key: felt252) {
            self.assert_only_self_or_controller();
            let old = self.sessions.read(session_key);
            let mut i: u32 = 0;
            loop {
                if i >= old.allowed_entrypoints_len {
                    break;
                }
                self.session_entrypoints.write((session_key, i), 0);
                i += 1;
            };
            self
                .sessions
                .write(
                    session_key,
                    SessionData { valid_until: 0, max_calls: 0, calls_used: 0, allowed_entrypoints_len: 0 },
                );
            self.emit(SessionKeyRevoked { session_key });
        }

        fn get_session_data(self: @ContractState, session_key: felt252) -> SessionData {
            self.sessions.read(session_key)
        }
    }

    // ------------------------------------------------------------------
    // Spending policy (owner-level: self or controller, v0.4), enforced in __execute__
    // ------------------------------------------------------------------
    #[abi(embed_v0)]
    impl GateSpendingPolicyImpl of IGateSpendingPolicy<ContractState> {
        fn set_spending_policy(
            ref self: ContractState,
            session_key: felt252,
            token: ContractAddress,
            max_per_call: u256,
            max_per_window: u256,
            window_seconds: u64,
        ) {
            self.assert_only_self_or_controller();
            self
                .spending
                .write(
                    (session_key, token),
                    SpendingPolicy {
                        max_per_call,
                        max_per_window,
                        window_seconds,
                        spent_in_window: 0,
                        window_start: starknet::get_block_timestamp(),
                    },
                );
            self.emit(SpendingPolicySet { session_key, token });
        }

        fn remove_spending_policy(
            ref self: ContractState, session_key: felt252, token: ContractAddress,
        ) {
            self.assert_only_self_or_controller();
            self
                .spending
                .write(
                    (session_key, token),
                    SpendingPolicy {
                        max_per_call: 0,
                        max_per_window: 0,
                        window_seconds: 0,
                        spent_in_window: 0,
                        window_start: 0,
                    },
                );
            self.emit(SpendingPolicyRemoved { session_key, token });
        }

        fn get_spending_policy(
            self: @ContractState, session_key: felt252, token: ContractAddress,
        ) -> SpendingPolicy {
            self.spending.read((session_key, token))
        }

        // v0.2 merchant allowlist: WHO the agent may pay, per (session, token).
        // Deny by default — a recipient the owner never listed cannot be paid.
        fn allow_recipient(
            ref self: ContractState,
            session_key: felt252,
            token: ContractAddress,
            recipient: ContractAddress,
        ) {
            self.assert_only_self_or_controller();
            self.recipients.write((session_key, token, recipient), true);
            self.emit(RecipientAllowed { session_key, token, recipient });
        }

        fn disallow_recipient(
            ref self: ContractState,
            session_key: felt252,
            token: ContractAddress,
            recipient: ContractAddress,
        ) {
            self.assert_only_self_or_controller();
            self.recipients.write((session_key, token, recipient), false);
            self.emit(RecipientDisallowed { session_key, token, recipient });
        }

        fn is_recipient_allowed(
            self: @ContractState,
            session_key: felt252,
            token: ContractAddress,
            recipient: ContractAddress,
        ) -> bool {
            self.recipients.read((session_key, token, recipient))
        }
    }

    // ------------------------------------------------------------------
    // Internal session logic
    // ------------------------------------------------------------------
    #[generate_trait]
    impl SessionInternal of SessionInternalTrait {
        // SNIP Part C: 8-step validation. Returns VALIDATED or 0 — a rejected session
        // tx must fail validation cleanly, not panic.
        fn validate_session(
            self: @ContractState,
            calls: Span<Call>,
            signature: Span<felt252>,
            chain_id: felt252,
            nonce: felt252,
        ) -> felt252 {
            let session_pubkey = *signature.at(0);
            let r = *signature.at(1);
            let s = *signature.at(2);

            // Step 1: safe felt252 -> u64 conversion (malformed input => reject, no panic).
            let sig_valid_until: u64 = match (*signature.at(3)).try_into() {
                Option::Some(v) => v,
                Option::None => {
                    return 0;
                },
            };

            // Step 2: expiry. NOTE: block_timestamp inside __validate__ is rounded to the
            // nearest hour by the protocol — expiry precision is ±1h (see DESIGN.md).
            if starknet::get_block_timestamp() > sig_valid_until {
                return 0;
            }

            // Step 3: session must exist (owner-registered, not revoked)...
            let session = self.sessions.read(session_pubkey);
            if session.valid_until == 0 {
                return 0;
            }
            // ...and the agent cannot claim a longer session than the owner granted.
            if sig_valid_until > session.valid_until {
                return 0;
            }

            // Step 4: call budget.
            if session.calls_used >= session.max_calls {
                return 0;
            }

            // Steps 5, 5b, 6 — per call: admin blocklist, self-call block, whitelist.
            let self_address = starknet::get_contract_address();
            for call in calls {
                let Call { to, selector, calldata: _ } = *call;
                // Step 5: privileged selectors can never be called by a session key.
                if is_admin_selector(selector) {
                    return 0;
                }
                if session.allowed_entrypoints_len == 0 {
                    // Step 5b: empty whitelist = no calls to the account itself at all
                    // (kills the privilege-escalation class).
                    if to == self_address {
                        return 0;
                    }
                } else if !self
                    .is_selector_allowed(
                        session_pubkey, session.allowed_entrypoints_len, selector,
                    ) {
                    // Step 6: explicit selector whitelist.
                    return 0;
                }
            };

            // Step 7: ECDSA over the session message hash (binds the signature to
            // exactly this account, chain, nonce, expiry, and call list).
            let msg_hash = compute_session_hash(
                self_address, chain_id, nonce, sig_valid_until, calls,
            );
            if !check_ecdsa_signature(msg_hash, session_pubkey, r, s) {
                return 0;
            }

            starknet::VALIDATED
        }

        // Consume one call from the session budget (runs in __execute__ only).
        fn consume_session_call(ref self: ContractState, session_key: felt252) {
            let mut session = self.sessions.read(session_key);
            session.calls_used += 1;
            self.sessions.write(session_key, session);
        }

        fn is_selector_allowed(
            self: @ContractState, session_key: felt252, len: u32, selector: felt252,
        ) -> bool {
            let mut i: u32 = 0;
            loop {
                if i >= len {
                    break false;
                }
                if self.session_entrypoints.read((session_key, i)) == selector {
                    break true;
                }
                i += 1;
            }
        }

        // SNIP Part H: per-token spending caps with a rolling window.
        // Deviation (deliberate, stricter): DENY BY DEFAULT — a spend selector without a
        // policy for (session, token) is rejected instead of unrestricted.
        fn enforce_spending(
            ref self: ContractState, calls: Span<Call>, session_key: felt252,
        ) {
            for call in calls {
                let Call { to, selector, calldata } = *call;
                if is_spend_selector(selector) {
                    // ERC-20 calldata layout: [recipient_or_spender, amount_low, amount_high].
                    if calldata.len() < 3 {
                        // Malformed: the token contract itself will reject it.
                        continue;
                    }
                    let amount = u256 {
                        low: (*calldata.at(1)).try_into().unwrap(),
                        high: (*calldata.at(2)).try_into().unwrap(),
                    };
                    let policy = self.spending.read((session_key, to));
                    assert!(
                        policy.max_per_call != 0 || policy.max_per_window != 0,
                        "GateAccount: no spending policy for token",
                    );
                    // v0.2 merchant allowlist: calldata[0] is the recipient for `transfer`
                    // and the spender for `approve` / `increase_allowance` — either way it is
                    // the address being handed value or spending power, so it must be listed.
                    // Deny by default: never listed => never payable.
                    let recipient: ContractAddress = (*calldata.at(0)).try_into().unwrap();
                    assert!(
                        self.recipients.read((session_key, to, recipient)),
                        "GateAccount: recipient not allowed",
                    );
                    if policy.max_per_call != 0 {
                        assert!(
                            amount <= policy.max_per_call,
                            "GateAccount: amount over per-call cap",
                        );
                    }
                    if policy.max_per_window != 0 {
                        let now = starknet::get_block_timestamp();
                        let mut spent = policy.spent_in_window;
                        let mut start = policy.window_start;
                        if now >= start + policy.window_seconds {
                            // Roll the window (e.g. a fresh month).
                            spent = 0;
                            start = now;
                        }
                        assert!(
                            spent + amount <= policy.max_per_window,
                            "GateAccount: over window cap",
                        );
                        self
                            .spending
                            .write(
                                (session_key, to),
                                SpendingPolicy {
                                    max_per_call: policy.max_per_call,
                                    max_per_window: policy.max_per_window,
                                    window_seconds: policy.window_seconds,
                                    spent_in_window: spent + amount,
                                    window_start: start,
                                },
                            );
                    }
                }
            };
        }
    }

    // ------------------------------------------------------------------
    // Free functions
    // ------------------------------------------------------------------

    // SNIP Part D admin blocklist, extended with this contract's privileged selectors.
    // Session keys can NEVER call these.
    fn is_admin_selector(selector: felt252) -> bool {
        selector == SEL_UPGRADE
            || selector == SEL_EXECUTE
            || selector == SEL_VALIDATE_DECLARE
            || selector == SEL_VALIDATE_DEPLOY
            || selector == SEL_SET_PUBLIC_KEY
            || selector == SEL_SET_PUBLIC_KEY_CAMEL
            || selector == SEL_EXECUTE_FROM_OUTSIDE_V2
            || selector == SEL_ADD_SESSION
            || selector == SEL_REVOKE_SESSION
            || selector == SEL_SET_SPENDING
            || selector == SEL_REMOVE_SPENDING
            || selector == SEL_ALLOW_RECIPIENT
            || selector == SEL_DISALLOW_RECIPIENT
            || selector == SEL_SET_WALLET_CONTROLLER
    }

    fn is_spend_selector(selector: felt252) -> bool {
        selector == SEL_TRANSFER
            || selector == SEL_APPROVE
            || selector == SEL_INCREASE_ALLOWANCE
            || selector == SEL_INCREASE_ALLOWANCE_CAMEL
    }

    // Session message hash (v0.1 local scheme; canonical SNIP-12 typed data arrives
    // with the SNIP-9 / paymaster integration in v1.1).
    fn compute_session_hash(
        account: ContractAddress,
        chain_id: felt252,
        nonce: felt252,
        valid_until: u64,
        calls: Span<Call>,
    ) -> felt252 {
        let mut fields: Array<felt252> = array![
            'GateAccount session v1', account.into(), chain_id, nonce, valid_until.into(),
        ];
        for call in calls {
            let Call { to, selector, calldata } = *call;
            fields.append(to.into());
            fields.append(selector);
            fields.append(poseidon_hash_span(calldata));
        };
        poseidon_hash_span(fields.span())
    }

    // felt252 has no BitXor, so the SRC-5 interface id is XORed in the u256 domain.
    // Inputs are selectors (< 2^250), so both conversions are lossless.
    fn xor3(a: felt252, b: felt252, c: felt252) -> felt252 {
        let ua: u256 = a.try_into().unwrap();
        let ub: u256 = b.try_into().unwrap();
        let uc: u256 = c.try_into().unwrap();
        let xored: u256 = ua ^ ub ^ uc;
        xored.try_into().unwrap()
    }

    // ------------------------------------------------------------------
    // v0.3: SNIP-12 hashing for outside execution (controller-bound)
    // ------------------------------------------------------------------

    // Domain exactly as SNIP-9 / OZ's SRC9Component defines it (SNIP12MetadataImpl:
    // name 'Account.execute_from_outside', version 2; revision 1 comes from the OZ
    // hash below). The JS carrier in permission-core/web/typed-data.js pins the same
    // domain; t35 and the JS drift test pin both sides to one hash vector.
    impl GateSNIP12Metadata of SNIP12Metadata {
        fn name() -> felt252 {
            'Account.execute_from_outside'
        }
        fn version() -> felt252 {
            2
        }
    }

    // Mirror of OZ's pub(crate) OffchainMessageHashImpl::get_message_hash
    // (utils/src/cryptography/snip12.cairo): poseidon over
    // ['StarkNet Message', domain_hash, signer, message_struct_hash]. Reproduced here
    // because (a) that impl is crate-private to openzeppelin_utils and (b) the signer
    // is the registered wallet_controller, not this contract. The struct hashes come
    // from OZ's pub impls (StructHashStarknetDomainImpl, OutsideExecutionStructHash),
    // so every type-hash constant is the library's — nothing retyped from memory.
    fn outside_execution_message_hash(
        outside_execution: @OutsideExecution, signer: ContractAddress, chain_id: felt252,
    ) -> felt252 {
        let domain = StarknetDomain {
            name: GateSNIP12Metadata::name(),
            version: GateSNIP12Metadata::version(),
            chain_id,
            revision: 1,
        };
        let mut state = PoseidonTrait::new();
        state = state.update_with('StarkNet Message');
        state = state.update_with(domain.hash_struct());
        state = state.update_with(signer);
        state = state.update_with(outside_execution.hash_struct());
        state.finalize()
    }
}
