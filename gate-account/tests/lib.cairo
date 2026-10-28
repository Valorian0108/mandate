//! GateAccount test suite — the 12 tests from DESIGN.md, extended to t17 (session-hash
//! JS agreement) and t18–t34 (v0.3: controller-bound SNIP-9, wallet-controller gating,
//! owner-gated upgrade).
//!
//! Protocol simulation: snforge does not run real transactions through the account,
//! so each "transaction" is simulated with cheatcodes:
//!   - caller cheated to zero (the protocol)   -> satisfies `caller == 0`
//!   - tx version cheated to 1                 -> satisfies `is_tx_version_valid`
//!   - tx signature cheated                    -> 2 felts = owner, 4 felts = session key
//!   - tx hash / nonce / chain id cheated      -> deterministic signing
//!
//! Session path is `[session_pubkey, r, s, valid_until]` over the same message hash
//! the contract computes in `compute_session_hash`.
//!
//! SNIP-9 path (t18+): `execute_from_outside_v2` is called DIRECTLY (it needs no
//! protocol simulation — any address may submit). The signed hash is the SNIP-12
//! OutsideExecution digest bound to the registered controller's address, mirrored in
//! `outside_execution_hash` below (same two-hop pinning as t17: happy-path tests pin
//! contract == mirror; t35 pins mirror == JavaScript).

mod evidence_registry;

use core::hash::{HashStateExTrait, HashStateTrait};
use core::poseidon::{PoseidonTrait, poseidon_hash_span};
use gate_account::mocks::{IERC20MockDispatcher, IERC20MockDispatcherTrait};
use gate_account::{
    IGateSpendingPolicyDispatcher, IGateSpendingPolicyDispatcherTrait, ISessionKeyManagerDispatcher,
    ISessionKeyManagerDispatcherTrait, IWalletControllerDispatcher,
    IWalletControllerDispatcherTrait,
};
use openzeppelin::account::extensions::src9::snip12_utils::OutsideExecutionStructHash;
use openzeppelin::interfaces::accounts::{
    IPublicKeyDispatcher, IPublicKeyDispatcherTrait, ISRC6Dispatcher, ISRC6DispatcherTrait,
};
use openzeppelin::interfaces::introspection::{ISRC5Dispatcher, ISRC5DispatcherTrait};
use openzeppelin::interfaces::src9::{
    ISRC9_V2Dispatcher, ISRC9_V2DispatcherTrait, ISRC9_V2_ID, OutsideExecution,
};
use openzeppelin::utils::cryptography::snip12::{
    StarknetDomain, StructHash, StructHashStarknetDomainImpl,
};
use snforge_std::signature::stark_curve::{StarkCurveKeyPairImpl, StarkCurveSignerImpl};
use snforge_std::signature::{KeyPair, SignerTrait};
use snforge_std::{
    ContractClass, ContractClassTrait, DeclareResult, declare, start_cheat_block_timestamp_global,
    cheat_caller_address, CheatSpan, start_cheat_chain_id_global, start_cheat_nonce_global,
    start_cheat_signature_global, start_cheat_transaction_hash_global,
    start_cheat_transaction_version_global,
};
use starknet::account::{AccountContractDispatcher, AccountContractDispatcherTrait, Call};
use starknet::{ClassHash, ContractAddress, VALIDATED};

type StarkKeyPair = KeyPair<felt252, felt252>;

const CHAIN_ID: felt252 = 'SN_GATE_TEST';
const TX_VERSION: felt252 = 1;
const OWNER_TX_HASH: felt252 = 'owner_tx';

#[derive(Drop, Copy)]
struct Env {
    account: ContractAddress,
    token: ContractAddress,
    owner: StarkKeyPair,
    session: StarkKeyPair,
}

// ------------------------------------------------------------------
// Deployment helpers
// ------------------------------------------------------------------

fn declare_class(name: ByteArray) -> ContractClass {
    match declare(name) {
        Result::Ok(result) => match result {
            DeclareResult::Success(class) => class,
            DeclareResult::AlreadyDeclared(class) => class,
        },
        Result::Err(_) => panic!("could not declare contract"),
    }
}

fn deploy(contract_class: ContractClass, calldata: Array<felt252>) -> ContractAddress {
    match contract_class.deploy(@calldata) {
        Result::Ok((address, _)) => address,
        Result::Err(_) => panic!("could not deploy contract"),
    }
}

fn zero() -> ContractAddress {
    0.try_into().unwrap()
}

fn addr(value: felt252) -> ContractAddress {
    value.try_into().unwrap()
}

fn agent() -> ContractAddress {
    addr('recipient')
}

fn owner_key() -> StarkKeyPair {
    StarkCurveKeyPairImpl::from_secret_key('owner_key')
}

fn session_key() -> StarkKeyPair {
    StarkCurveKeyPairImpl::from_secret_key('agent_key')
}

// Deploys one account + one mock token funded with 100_000 units of the account.
fn setup() -> Env {
    let owner = owner_key();
    let session = session_key();
    let account = deploy(declare_class("GateAccount"), array![owner.public_key]);
    let token = deploy(declare_class("ERC20Mock"), array![account.into(), 100_000, 0]);

    // Deterministic clock. Session `__validate__` rounds timestamps to the hour on
    // real networks; under snforge the value we cheat here is what the contract sees.
    start_cheat_block_timestamp_global(1_000_000);

    Env { account, token, owner, session }
}

fn session_dispatcher(env: Env) -> ISessionKeyManagerDispatcher {
    ISessionKeyManagerDispatcher { contract_address: env.account }
}

fn policy_dispatcher(env: Env) -> IGateSpendingPolicyDispatcher {
    IGateSpendingPolicyDispatcher { contract_address: env.account }
}

fn token_dispatcher(env: Env) -> IERC20MockDispatcher {
    IERC20MockDispatcher { contract_address: env.token }
}

// ------------------------------------------------------------------
// Call builders
// ------------------------------------------------------------------

fn copy_calls(calls: Span<Call>) -> Array<Call> {
    let mut out: Array<Call> = array![];
    for call in calls {
        out.append(*call);
    };
    out
}

fn transfer_call(token: ContractAddress, recipient: ContractAddress, amount: u256) -> Call {
    let mut calldata = array![recipient.into(), amount.low.into(), amount.high.into()];
    Call { to: token, selector: selector!("transfer"), calldata: calldata.span() }
}

fn add_session_call(
    account: ContractAddress,
    session_key: felt252,
    valid_until: u64,
    max_calls: u32,
    allowed_entrypoints: Span<felt252>,
) -> Call {
    let len: u32 = allowed_entrypoints.len();
    let mut calldata = array![session_key, valid_until.into(), max_calls.into(), len.into()];
    for entrypoint in allowed_entrypoints {
        calldata.append(*entrypoint);
    };
    Call {
        to: account, selector: selector!("add_or_update_session_key"), calldata: calldata.span(),
    }
}

fn set_policy_call(
    account: ContractAddress,
    session_key: felt252,
    token: ContractAddress,
    max_per_call: u256,
    max_per_window: u256,
    window_seconds: u64,
) -> Call {
    let mut calldata = array![
        session_key,
        token.into(),
        max_per_call.low.into(),
        max_per_call.high.into(),
        max_per_window.low.into(),
        max_per_window.high.into(),
        window_seconds.into(),
    ];
    Call { to: account, selector: selector!("set_spending_policy"), calldata: calldata.span() }
}

fn allow_recipient_call(
    account: ContractAddress,
    session_key: felt252,
    token: ContractAddress,
    recipient: ContractAddress,
) -> Call {
    let mut calldata = array![session_key, token.into(), recipient.into()];
    Call { to: account, selector: selector!("allow_recipient"), calldata: calldata.span() }
}

fn disallow_recipient_call(
    account: ContractAddress,
    session_key: felt252,
    token: ContractAddress,
    recipient: ContractAddress,
) -> Call {
    let mut calldata = array![session_key, token.into(), recipient.into()];
    Call { to: account, selector: selector!("disallow_recipient"), calldata: calldata.span() }
}

fn revoke_call(env: Env) -> Call {
    let mut calldata = array![env.session.public_key];
    Call { to: env.account, selector: selector!("revoke_session_key"), calldata: calldata.span() }
}

// ------------------------------------------------------------------
// Owner transaction path (2-felt signature)
// ------------------------------------------------------------------

fn validate_owner(env: Env, calls: Span<Call>) -> felt252 {
    start_cheat_transaction_hash_global(OWNER_TX_HASH);
    start_cheat_transaction_version_global(TX_VERSION);
    cheat_caller_address(env.account, zero(), CheatSpan::TargetCalls(1));

    let (r, s) = env.owner.sign(OWNER_TX_HASH).unwrap();
    start_cheat_signature_global(array![r, s].span());

    AccountContractDispatcher { contract_address: env.account }.__validate__(copy_calls(calls))
}

fn execute_calls(env: Env, calls: Span<Call>) -> Array<Span<felt252>> {
    start_cheat_transaction_version_global(TX_VERSION);
    cheat_caller_address(env.account, zero(), CheatSpan::TargetCalls(1));
    AccountContractDispatcher { contract_address: env.account }.__execute__(copy_calls(calls))
}

fn owner_execute(env: Env, calls: Span<Call>) {
    let validated = validate_owner(env, calls);
    assert!(validated == VALIDATED, "owner transaction should validate");
    execute_calls(env, calls);
}

// ------------------------------------------------------------------
// Session transaction path (4-felt signature)
// ------------------------------------------------------------------

// Mirrors `compute_session_hash` in src/lib.cairo.
fn session_hash(
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

fn session_signature(
    env: Env, valid_until: u64, calls: Span<Call>, nonce: felt252,
) -> Array<felt252> {
    let hash = session_hash(env.account, CHAIN_ID, nonce, valid_until, calls);
    let (r, s) = env.session.sign(hash).unwrap();
    array![env.session.public_key, r, s, valid_until.into()]
}

fn session_validate(
    env: Env, signature: Span<felt252>, calls: Span<Call>, nonce: felt252,
) -> felt252 {
    start_cheat_chain_id_global(CHAIN_ID);
    start_cheat_nonce_global(nonce);
    start_cheat_transaction_version_global(TX_VERSION);
    cheat_caller_address(env.account, zero(), CheatSpan::TargetCalls(1));
    start_cheat_signature_global(signature);

    AccountContractDispatcher { contract_address: env.account }.__validate__(copy_calls(calls))
}

fn session_execute(
    env: Env, signature: Span<felt252>, calls: Span<Call>,
) -> Array<Span<felt252>> {
    start_cheat_chain_id_global(CHAIN_ID);
    start_cheat_transaction_version_global(TX_VERSION);
    cheat_caller_address(env.account, zero(), CheatSpan::TargetCalls(1));
    start_cheat_signature_global(signature);

    AccountContractDispatcher { contract_address: env.account }.__execute__(copy_calls(calls))
}

fn validate_and_execute_session(
    env: Env, signature: Span<felt252>, calls: Span<Call>, nonce: felt252,
) {
    let validated = session_validate(env, signature, calls, nonce);
    assert!(validated == VALIDATED, "session transaction should validate");
    session_execute(env, signature, calls);
}

// ------------------------------------------------------------------
// Owner setup shortcuts
// ------------------------------------------------------------------

fn register_agent(env: Env, valid_until: u64, max_calls: u32) {
    let whitelist = array![selector!("transfer")];
    let calls = array![
        add_session_call(env.account, env.session.public_key, valid_until, max_calls, whitelist.span()),
    ];
    owner_execute(env, calls.span());
}

fn register_agent_with_policy(
    env: Env, valid_until: u64, max_calls: u32, max_per_call: u256, max_per_window: u256,
) {
    let whitelist = array![selector!("transfer")];
    // One owner transaction granting the whole mandate: which agent key, which entrypoint,
    // how much, and to which merchant. `agent()` is the only payable recipient.
    let calls = array![
        add_session_call(env.account, env.session.public_key, valid_until, max_calls, whitelist.span()),
        set_policy_call(env.account, env.session.public_key, env.token, max_per_call, max_per_window, 2_592_000),
        allow_recipient_call(env.account, env.session.public_key, env.token, agent()),
    ];
    owner_execute(env, calls.span());
}

// ==================================================================
// 1. Owner sets policy: monthly cap 100, per-call cap 10, session for agent.
// ==================================================================
#[test]
fn t01_owner_sets_session_and_policy() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 10, 10, 100);

    let session = session_dispatcher(env).get_session_data(env.session.public_key);
    assert!(session.valid_until == 2_000_000, "wrong expiry");
    assert!(session.max_calls == 10, "wrong max calls");
    assert!(session.calls_used == 0, "calls should start at zero");

    let policy = policy_dispatcher(env)
        .get_spending_policy(env.session.public_key, env.token);
    assert!(policy.max_per_call == 10, "wrong per-call cap");
    assert!(policy.max_per_window == 100, "wrong window cap");
    assert!(policy.window_seconds == 2_592_000, "wrong window length");
}

// ==================================================================
// 2. Agent session key sends transfer of 10 -> passes.
// ==================================================================
#[test]
fn t02_session_transfer_within_cap_passes() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 10, 10, 100);

    let calls = array![transfer_call(env.token, agent(), 10)];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);
    validate_and_execute_session(env, signature.span(), calls.span(), 1);

    assert!(token_dispatcher(env).balance_of(agent()) == 10, "agent should receive 10");
    let session = session_dispatcher(env).get_session_data(env.session.public_key);
    assert!(session.calls_used == 1, "one call should be consumed");
}

// ==================================================================
// 3. Agent session key sends transfer of 11 -> REJECTED in __execute__ (per-call cap).
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: amount over per-call cap")]
fn t03_session_transfer_over_per_call_cap_rejected() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 10, 10, 100);

    let calls = array![transfer_call(env.token, agent(), 11)];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);
    validate_and_execute_session(env, signature.span(), calls.span(), 1);
}

// ==================================================================
// 4. Transfer 10 repeatedly until the window cap -> next one REJECTED.
//    per-call = 10, window = 25  =>  10 + 10 pass, third (30 > 25) rejected.
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: over window cap")]
fn t04_session_transfer_over_window_cap_rejected() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 10, 10, 25);

    // First two transfers fit inside the 25-unit window.
    let calls1 = array![transfer_call(env.token, agent(), 10)];
    let sig1 = session_signature(env, 2_000_000, calls1.span(), 1);
    validate_and_execute_session(env, sig1.span(), calls1.span(), 1);

    let calls2 = array![transfer_call(env.token, agent(), 10)];
    let sig2 = session_signature(env, 2_000_000, calls2.span(), 2);
    validate_and_execute_session(env, sig2.span(), calls2.span(), 2);

    assert!(token_dispatcher(env).balance_of(agent()) == 20, "two transfers should land");

    // Third one would take the window to 30 > 25.
    let calls3 = array![transfer_call(env.token, agent(), 10)];
    let sig3 = session_signature(env, 2_000_000, calls3.span(), 3);
    validate_and_execute_session(env, sig3.span(), calls3.span(), 3);
}

// ==================================================================
// 5. Agent tries to raise its own limits -> REJECTED in __validate__ (blocklist).
// ==================================================================
#[test]
fn t05_session_cannot_add_or_update_session_key() {
    let env = setup();
    register_agent(env, 2_000_000, 10);

    let empty: Array<felt252> = array![];
    let calls = array![
        add_session_call(env.account, env.session.public_key, 9_999_999, 1_000, empty.span()),
    ];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);

    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "session must not manage session keys");
}

// ==================================================================
// 6. Agent tries to take over the account via set_public_key -> REJECTED in __validate__.
// ==================================================================
#[test]
fn t06_session_cannot_set_public_key() {
    let env = setup();
    register_agent(env, 2_000_000, 10);

    let mut calldata = array!['bad_actor'];
    let calls = array![
        Call { to: env.account, selector: selector!("set_public_key"), calldata: calldata.span() },
    ];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);

    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "session must not rotate the owner key");
}

// ==================================================================
// 7. Owner revokes the session -> agent's next transaction REJECTED in __validate__.
// ==================================================================
#[test]
fn t07_revoked_session_rejected() {
    let env = setup();
    register_agent(env, 2_000_000, 10);

    let revoke = array![revoke_call(env)];
    owner_execute(env, revoke.span());

    let calls = array![transfer_call(env.token, agent(), 1)];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);

    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "revoked session must not validate");
}

// ==================================================================
// 8. Expired session -> REJECTED in __validate__.
// ==================================================================
#[test]
fn t08_expired_session_rejected() {
    let env = setup();
    register_agent(env, 1_500_000, 10);

    // Move the clock past the session expiry.
    start_cheat_block_timestamp_global(1_600_000);

    let calls = array![transfer_call(env.token, agent(), 1)];
    let signature = session_signature(env, 1_500_000, calls.span(), 1);

    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "expired session must not validate");
}

// ==================================================================
// 9. max_calls exhaustion -> REJECTED in __validate__.
// ==================================================================
#[test]
fn t09_max_calls_exhausted_rejected() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 1, 10, 100);

    let calls1 = array![transfer_call(env.token, agent(), 1)];
    let sig1 = session_signature(env, 2_000_000, calls1.span(), 1);
    validate_and_execute_session(env, sig1.span(), calls1.span(), 1);

    let calls2 = array![transfer_call(env.token, agent(), 1)];
    let sig2 = session_signature(env, 2_000_000, calls2.span(), 2);
    let validated = session_validate(env, sig2.span(), calls2.span(), 2);
    assert!(validated == 0, "exhausted call budget must not validate");
}

// ==================================================================
// 10. Owner 2-element signature can do everything (policy, session, revocation).
// ==================================================================
#[test]
fn t10_owner_keeps_full_control() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 10, 10, 100);

    // Owner raises the caps.
    let update = array![
        set_policy_call(env.account, env.session.public_key, env.token, 50, 500, 2_592_000),
    ];
    owner_execute(env, update.span());

    let policy = policy_dispatcher(env)
        .get_spending_policy(env.session.public_key, env.token);
    assert!(policy.max_per_call == 50, "owner could not raise per-call cap");
    assert!(policy.max_per_window == 500, "owner could not raise window cap");

    // Owner replaces the session (new expiry, reset budget).
    let whitelist = array![selector!("transfer")];
    let update_session = array![
        add_session_call(env.account, env.session.public_key, 3_000_000, 99, whitelist.span()),
    ];
    owner_execute(env, update_session.span());
    let session = session_dispatcher(env).get_session_data(env.session.public_key);
    assert!(session.valid_until == 3_000_000, "owner could not update session");
    assert!(session.max_calls == 99, "owner could not update call budget");

    // Owner revokes it.
    let revoke = array![revoke_call(env)];
    owner_execute(env, revoke.span());
    let revoked = session_dispatcher(env).get_session_data(env.session.public_key);
    assert!(revoked.valid_until == 0, "owner could not revoke session");
}

// ==================================================================
// 11. Spend selector with NO policy for that token -> REJECTED (deny by default).
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: no spending policy for token")]
fn t11_spend_without_policy_rejected() {
    let env = setup();
    // Session registered, but no spending policy for the token.
    register_agent(env, 2_000_000, 10);

    let calls = array![transfer_call(env.token, agent(), 1)];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);
    validate_and_execute_session(env, signature.span(), calls.span(), 1);
}

// ==================================================================
// 12. Signature claiming a longer expiry than the registered session -> REJECTED.
// ==================================================================
#[test]
fn t12_signature_cannot_extend_expiry() {
    let env = setup();
    register_agent(env, 2_000_000, 10);

    let calls = array![transfer_call(env.token, agent(), 1)];
    // Agent signs for 3_000_000 although the owner granted only 2_000_000.
    let signature = session_signature(env, 3_000_000, calls.span(), 1);

    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "signature must not outlive the registered session");
}

// ==================================================================
// 13. v0.2 merchant allowlist: in-cap transfer to a recipient the owner never
//     listed -> REJECTED in __execute__ (deny by default).
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: recipient not allowed")]
fn t13_transfer_to_unlisted_recipient_rejected() {
    let env = setup();
    // This grants the agent `agent()` as its only payable merchant.
    register_agent_with_policy(env, 2_000_000, 10, 10, 100);

    let stranger = addr('stranger');
    // Amount is inside both caps and the selector is whitelisted: only WHO is wrong.
    let calls = array![transfer_call(env.token, stranger, 5)];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);
    validate_and_execute_session(env, signature.span(), calls.span(), 1);
}

// ==================================================================
// 14. The merchant list is owner-controlled: allow -> disallow -> allow.
// ==================================================================
#[test]
fn t14_owner_controls_recipient_allowlist() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 10, 10, 100);
    let policy = policy_dispatcher(env);
    let merchant = addr('merchant');

    assert!(
        !policy.is_recipient_allowed(env.session.public_key, env.token, merchant),
        "an unlisted merchant must read as denied",
    );

    // Owner lists the merchant.
    let allow = array![
        allow_recipient_call(env.account, env.session.public_key, env.token, merchant),
    ];
    owner_execute(env, allow.span());
    assert!(
        policy.is_recipient_allowed(env.session.public_key, env.token, merchant),
        "owner could not allow a merchant",
    );

    // Owner delists it again.
    let disallow = array![
        disallow_recipient_call(env.account, env.session.public_key, env.token, merchant),
    ];
    owner_execute(env, disallow.span());
    assert!(
        !policy.is_recipient_allowed(env.session.public_key, env.token, merchant),
        "owner could not disallow a merchant",
    );
}

// ==================================================================
// 15. Delisting a merchant kills an otherwise-valid agent transaction.
//     Note the split: __validate__ still says VALIDATED (it has no merchant
//     context), __execute__ is where the payment is stopped.
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: recipient not allowed")]
fn t15_delisted_merchant_blocks_transfer() {
    let env = setup();
    register_agent_with_policy(env, 2_000_000, 10, 10, 100);

    // Owner removes `agent()` from the allowlist.
    let disallow = array![
        disallow_recipient_call(env.account, env.session.public_key, env.token, agent()),
    ];
    owner_execute(env, disallow.span());

    let calls = array![transfer_call(env.token, agent(), 5)];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);

    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == VALIDATED, "merchant checks live in __execute__, not __validate__");
    session_execute(env, signature.span(), calls.span());
}

// ==================================================================
// 16. Blocklist outranks whitelist: even if the owner whitelists
//     `allow_recipient`, a session key can never edit its own merchant list.
// ==================================================================
#[test]
fn t16_session_cannot_allow_recipient_for_itself() {
    let env = setup();
    // Owner (over-permissively) whitelists the privileged selector itself.
    let whitelist = array![selector!("transfer"), selector!("allow_recipient")];
    let grant = array![
        add_session_call(env.account, env.session.public_key, 2_000_000, 10, whitelist.span()),
    ];
    owner_execute(env, grant.span());

    let calls = array![
        allow_recipient_call(env.account, env.session.public_key, env.token, addr('stranger')),
    ];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);

    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "session must not manage the merchant allowlist");
}

// ==================================================================
// 17. Cross-implementation hash agreement (Stage 2 gate).
//     tools/agent-tx.mjs computes the session hash in JavaScript for the
//     canonical LIVE Sepolia vector (real gate account, SN_SEPOLIA chain id,
//     nonce 4, merchant transfer of 5). This test asserts Cairo's
//     poseidon_hash_span pipeline produces the IDENTICAL felt. If this ever
//     fails, the JS submitter would sign a hash the contract cannot verify
//     and every agent transaction would be rejected.
// ==================================================================
#[test]
fn t17_session_hash_matches_javascript_submitter() {
    let account = addr(0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25);
    let token = addr(0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd);
    let merchant = addr(0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38);
    let chain_id: felt252 = 0x534e5f5345504f4c4941; // 'SN_SEPOLIA'
    let nonce: felt252 = 4;
    let valid_until: u64 = 2000000000;

    let calls = array![transfer_call(token, merchant, 5)];
    let hash = session_hash(account, chain_id, nonce, valid_until, calls.span());

    // Value printed by: node tools/agent-tx.mjs --hash-only
    assert!(
        hash == 0x75179a2c29e2dba769269b848427ef3abed8bbf260f09ddcddd71a8527be9d9,
        "JS and Cairo session hashes diverged",
    );
}

// ==================================================================
// v0.3 — controller-bound SNIP-9 (t18–t35)
//
// Panic-shape rule (found the hard way): GateAccount's own errors are ByteArrays
// (`assert!(cond, "msg")` house style) and pin as string literals in should_panic;
// errors raised INSIDE OpenZeppelin code are felt252 shortstrings and must pin as
// felt tuples — `assert_valid_signature` takes invalid_signature_error: felt252, and
// `assert_only_self` panics with Errors::UNAUTHORIZED: felt252. Through a dispatcher
// both shapes arrive wrapped with a trailing 'ENTRYPOINT_FAILED' felt.
// ==================================================================

// The contract's `upgrade` has no interface (bare #[external(v0)]), so the tests
// declare a matching probe trait to get a dispatcher for the direct-call control.
#[starknet::interface]
pub trait IUpgradeProbe<TContractState> {
    fn upgrade(ref self: TContractState, new_class_hash: ClassHash);
}

// Mirror of `outside_execution_message_hash` in src/lib.cairo (which mirrors OZ's
// pub(crate) get_message_hash: poseidon over ['StarkNet Message', domain_hash,
// signer, message_struct_hash], domain = SNIP-9's 'Account.execute_from_outside'
// version 2 revision 1). Two-hop pinning: t18–t29 make the CONTRACT verify hashes
// produced by this mirror (any divergence fails every happy path), and t35 pins
// this mirror to the JavaScript typed-data oracle. Together: contract == JS.
fn outside_execution_hash(
    signer: ContractAddress, chain_id: felt252, outside_execution: @OutsideExecution,
) -> felt252 {
    let domain = StarknetDomain {
        name: 'Account.execute_from_outside', version: 2, chain_id, revision: 1,
    };
    let mut state = PoseidonTrait::new();
    state = state.update_with('StarkNet Message');
    state = state.update_with(domain.hash_struct());
    state = state.update_with(signer);
    state = state.update_with(outside_execution.hash_struct());
    state.finalize()
}

fn any_caller() -> ContractAddress {
    addr('ANY_CALLER')
}

// Default execution window around the cheated clock (setup pins now = 1_000_000).
const OE_AFTER: u64 = 999_000;
const OE_BEFORE: u64 = 1_001_000;

fn make_outside(
    caller: ContractAddress, nonce: felt252, calls: Span<Call>,
) -> OutsideExecution {
    OutsideExecution {
        caller, nonce, execute_after: OE_AFTER, execute_before: OE_BEFORE, calls,
    }
}

fn outside_dispatcher(env: Env) -> ISRC9_V2Dispatcher {
    ISRC9_V2Dispatcher { contract_address: env.account }
}

fn controller_dispatcher(env: Env) -> IWalletControllerDispatcher {
    IWalletControllerDispatcher { contract_address: env.account }
}

fn set_controller_call(account: ContractAddress, controller: ContractAddress) -> Call {
    let calldata = array![controller.into()];
    Call { to: account, selector: selector!("set_wallet_controller"), calldata: calldata.span() }
}

fn upgrade_call(account: ContractAddress, new_class_hash: ClassHash) -> Call {
    let calldata = array![new_class_hash.into()];
    Call { to: account, selector: selector!("upgrade"), calldata: calldata.span() }
}

// The pasted-key proof shape: the account registers ITSELF as controller, so a plain
// EOA-style signature (owner key over the SNIP-12 hash) verifies through the
// account's own owner-only is_valid_signature. No wallet needed for the on-chain half.
fn register_self_controller(env: Env) {
    let calls = array![set_controller_call(env.account, env.account)];
    owner_execute(env, calls.span());
}

fn register_controller(env: Env, controller: ContractAddress) {
    let calls = array![set_controller_call(env.account, controller)];
    owner_execute(env, calls.span());
}

fn owner_sign_outside(
    env: Env, controller: ContractAddress, outside_execution: @OutsideExecution,
) -> Array<felt252> {
    start_cheat_chain_id_global(CHAIN_ID);
    let hash = outside_execution_hash(controller, CHAIN_ID, outside_execution);
    let (r, s) = env.owner.sign(hash).unwrap();
    array![r, s]
}

fn submit_outside(
    env: Env, outside_execution: OutsideExecution, signature: Span<felt252>,
) -> Array<Span<felt252>> {
    start_cheat_chain_id_global(CHAIN_ID);
    outside_dispatcher(env).execute_from_outside_v2(outside_execution, signature)
}

// ==================================================================
// 18. SNIP-9 happy path with a SELF-registered controller (the pasted-key proof
//     shape): owner signs the OutsideExecution digest, ANY relayer submits, the
//     transfer lands, the nonce is consumed, SRC-5 advertises ISRC9_V2. If the
//     contract's hash diverged from the mirror, this test fails.
// ==================================================================
#[test]
fn t18_outside_execution_happy_path_self_controller() {
    let env = setup();
    register_self_controller(env);
    assert!(
        controller_dispatcher(env).get_wallet_controller() == env.account,
        "controller not registered",
    );

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(any_caller(), 'nonce-1', calls.span());
    let signature = owner_sign_outside(env, env.account, @outside);
    submit_outside(env, outside, signature.span());

    assert!(token_dispatcher(env).balance_of(agent()) == 5, "transfer did not land");
    assert!(
        !outside_dispatcher(env).is_valid_outside_execution_nonce('nonce-1'),
        "nonce must be consumed",
    );
    assert!(
        ISRC5Dispatcher { contract_address: env.account }.supports_interface(ISRC9_V2_ID),
        "constructor must advertise ISRC9_V2",
    );
}

// ==================================================================
// 19. A named caller passes when the submitter IS the signed caller.
// ==================================================================
#[test]
fn t19_outside_execution_named_caller_passes() {
    let env = setup();
    register_self_controller(env);
    let relayer = addr('relayer');

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(relayer, 'n19', calls.span());
    let signature = owner_sign_outside(env, env.account, @outside);

    start_cheat_chain_id_global(CHAIN_ID);
    cheat_caller_address(env.account, relayer, CheatSpan::TargetCalls(1));
    outside_dispatcher(env).execute_from_outside_v2(outside, signature.span());

    assert!(token_dispatcher(env).balance_of(agent()) == 5, "named-caller submission failed");
}

// ==================================================================
// 20. Signed for `relayer`, submitted by someone else -> REJECTED. The signature
//     itself is perfect; the ONLY defect is who is submitting.
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: invalid caller")]
fn t20_outside_execution_wrong_caller_rejected() {
    let env = setup();
    register_self_controller(env);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(addr('relayer'), 'n20', calls.span());
    let signature = owner_sign_outside(env, env.account, @outside);
    submit_outside(env, outside, signature.span());
}

// ==================================================================
// 21. Window expired (execute_before below the clock) -> REJECTED. Everything else
//     valid, signature over exactly this payload: the window is the only defect.
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: expired")]
fn t21_outside_execution_expired_window_rejected() {
    let env = setup();
    register_self_controller(env);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = OutsideExecution {
        caller: any_caller(),
        nonce: 'n21',
        execute_after: OE_AFTER,
        execute_before: 999_999, // now = 1_000_000; bounds are exclusive
        calls: calls.span(),
    };
    let signature = owner_sign_outside(env, env.account, @outside);
    submit_outside(env, outside, signature.span());
}

// ==================================================================
// 22. Window not open yet (execute_after == now) -> REJECTED, same single-defect
//     discipline as t21.
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: too early")]
fn t22_outside_execution_not_yet_valid_rejected() {
    let env = setup();
    register_self_controller(env);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = OutsideExecution {
        caller: any_caller(),
        nonce: 'n22',
        execute_after: 1_000_000, // now = 1_000_000; bounds are exclusive
        execute_before: OE_BEFORE,
        calls: calls.span(),
    };
    let signature = owner_sign_outside(env, env.account, @outside);
    submit_outside(env, outside, signature.span());
}

// ==================================================================
// 23. Replay: the identical authorization submitted twice -> the second is
//     REJECTED. First one lands (proved inside the test), so the nonce is the
//     only defect.
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: duplicated nonce")]
fn t23_outside_execution_replayed_nonce_rejected() {
    let env = setup();
    register_self_controller(env);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(any_caller(), 'n23', calls.span());
    let signature = owner_sign_outside(env, env.account, @outside);

    submit_outside(env, outside, signature.span());
    assert!(token_dispatcher(env).balance_of(agent()) == 5, "first submission should land");

    submit_outside(env, outside, signature.span());
}

// ==================================================================
// 24. Substituted calls: signature made over a 5-unit transfer, submitted with a
//     50-unit transfer under the same nonce/window -> REJECTED (hash binds calls).
// ==================================================================
#[test]
#[should_panic(expected: ('GateAccount: invalid signature', 'ENTRYPOINT_FAILED'))]
fn t24_outside_execution_substituted_calls_rejected() {
    let env = setup();
    register_self_controller(env);

    let signed_calls = array![transfer_call(env.token, agent(), 5)];
    let signed = make_outside(any_caller(), 'n24', signed_calls.span());
    let signature = owner_sign_outside(env, env.account, @signed);

    let swapped_calls = array![transfer_call(env.token, agent(), 50)];
    let swapped = make_outside(any_caller(), 'n24', swapped_calls.span());
    submit_outside(env, swapped, signature.span());
}

// ==================================================================
// 25. Wrong key: a stranger signs the correct hash -> REJECTED by the controller
//     (GateAccount's own owner-only is_valid_signature).
// ==================================================================
#[test]
#[should_panic(expected: ('GateAccount: invalid signature', 'ENTRYPOINT_FAILED'))]
fn t25_outside_execution_wrong_key_rejected() {
    let env = setup();
    register_self_controller(env);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(any_caller(), 'n25', calls.span());

    start_cheat_chain_id_global(CHAIN_ID);
    let hash = outside_execution_hash(env.account, CHAIN_ID, @outside);
    let stranger = StarkCurveKeyPairImpl::from_secret_key('stranger_key');
    let (r, s) = stranger.sign(hash).unwrap();
    submit_outside(env, outside, array![r, s].span());
}

// ==================================================================
// 26. Session-key refusal: the agent's REGISTERED session key signs the outside
//     execution hash. It is a valid key on this account — but is_valid_signature is
//     owner-only, so a session key can never self-authorize owner-level outside
//     execution.
// ==================================================================
#[test]
#[should_panic(expected: ('GateAccount: invalid signature', 'ENTRYPOINT_FAILED'))]
fn t26_session_key_cannot_authorize_outside_execution() {
    let env = setup();
    register_self_controller(env);
    register_agent(env, 2_000_000, 10);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(any_caller(), 'n26', calls.span());

    start_cheat_chain_id_global(CHAIN_ID);
    let hash = outside_execution_hash(env.account, CHAIN_ID, @outside);
    let (r, s) = env.session.sign(hash).unwrap();
    submit_outside(env, outside, array![r, s].span());
}

// ==================================================================
// 27. Unregistered controller: deny by default. A perfect owner signature is
//     useless until the owner registers a controller; the only defect is the
//     missing registration.
// ==================================================================
#[test]
#[should_panic(expected: "GateAccount: no controller")]
fn t27_outside_execution_without_controller_rejected() {
    let env = setup();
    // NO register_self_controller here — that absence is the whole test.

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(any_caller(), 'n27', calls.span());
    let signature = owner_sign_outside(env, env.account, @outside);
    submit_outside(env, outside, signature.span());
}

// ==================================================================
// 28. Registered controller that REFUSES: a perfect owner-key signature over the
//     correct hash still fails, because the registered controller's word is law.
// ==================================================================
#[test]
#[should_panic(expected: ('GateAccount: invalid signature', 'ENTRYPOINT_FAILED'))]
fn t28_refusing_controller_blocks_even_perfect_owner_signature() {
    let env = setup();
    let refusing = deploy(declare_class("RefusingController"), array![]);
    register_controller(env, refusing);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(any_caller(), 'n28', calls.span());
    let signature = owner_sign_outside(env, refusing, @outside);
    submit_outside(env, outside, signature.span());
}

// ==================================================================
// 29. Delegation is real: a rubber-stamp controller passes a GARBAGE signature —
//     proof the contract delegates verification instead of secretly checking the
//     owner key locally. Safe because choosing the controller is itself owner-only
//     and recorded on-chain (t30/t31) — a Layer B decision, enforced.
// ==================================================================
#[test]
fn t29_rubber_stamp_controller_proves_delegation() {
    let env = setup();
    let stamp = deploy(declare_class("RubberStampController"), array![]);
    register_controller(env, stamp);

    let calls = array![transfer_call(env.token, agent(), 5)];
    let outside = make_outside(any_caller(), 'n29', calls.span());
    submit_outside(env, outside, array![1, 2].span());

    assert!(token_dispatcher(env).balance_of(agent()) == 5, "delegated verification failed");
}

// ==================================================================
// 30. set_wallet_controller from outside the owner path -> REJECTED by
//     assert_only_self (error string pinned from OZ AccountComponent source).
// ==================================================================
#[test]
#[should_panic(expected: ('Account: unauthorized', 'ENTRYPOINT_FAILED'))]
fn t30_set_wallet_controller_requires_owner_path() {
    let env = setup();
    controller_dispatcher(env).set_wallet_controller(addr('attacker'));
}

// ==================================================================
// 31. Session key tries to register a controller -> REJECTED in __validate__
//     (admin blocklist). An agent can never swap in its own signer.
// ==================================================================
#[test]
fn t31_session_cannot_set_wallet_controller() {
    let env = setup();
    register_agent(env, 2_000_000, 10);

    let calls = array![set_controller_call(env.account, addr('attacker'))];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);
    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "session must not register a controller");
}

// ==================================================================
// 32. Session key tries to upgrade the account -> REJECTED in __validate__
//     (admin blocklist, unchanged from v0.1 — now guarding a real entry point).
// ==================================================================
#[test]
fn t32_session_cannot_upgrade() {
    let env = setup();
    register_agent(env, 2_000_000, 10);

    let calls = array![upgrade_call(env.account, 0x1234.try_into().unwrap())];
    let signature = session_signature(env, 2_000_000, calls.span(), 1);
    let validated = session_validate(env, signature.span(), calls.span(), 1);
    assert!(validated == 0, "session must not upgrade the account");
}

// ==================================================================
// 33. Direct upgrade call (not through the owner path) -> REJECTED by
//     assert_only_self.
// ==================================================================
#[test]
#[should_panic(expected: ('Account: unauthorized', 'ENTRYPOINT_FAILED'))]
fn t33_upgrade_requires_owner_path() {
    let env = setup();
    IUpgradeProbeDispatcher { contract_address: env.account }
        .upgrade(0x1234.try_into().unwrap());
}

// ==================================================================
// 34. Owner CAN upgrade in place, and storage survives: register the controller,
//     replace the class with the same declared class, controller still set. This
//     is the migration promise v0.2 could not make — from v0.3 on, upgrades are
//     owner-signed actions that preserve state.
// ==================================================================
#[test]
fn t34_owner_can_upgrade_in_place_preserving_state() {
    let env = setup();
    register_self_controller(env);

    let class = declare_class("GateAccount");
    let calls = array![upgrade_call(env.account, class.class_hash)];
    owner_execute(env, calls.span());

    assert!(
        controller_dispatcher(env).get_wallet_controller() == env.account,
        "in-place upgrade must preserve state",
    );
}

// ==================================================================
// 35. Cross-language hash pin (mirror == JavaScript), the t17 pattern for SNIP-9.
//     t18–t29 prove contract == mirror (every happy path has the contract verify
//     an ECDSA signature over a mirror-produced hash); this test proves
//     mirror == JS: the literal below is printed by `node tools/snip9-vector.mjs`,
//     which hashes the identical vector through permission-core/web/typed-data.js
//     (itself pinned to starknet.js 10.8.0 as oracle in typed-data.test.mjs, which
//     also pins THIS literal). Chain: contract == Cairo mirror == JS == starknet.js.
//     The vector uses the Sepolia fixture addresses on purpose — it pins hash
//     maths, not live state, so it must never change when the gate is redeployed.
// ==================================================================
#[test]
fn t35_outside_execution_hash_matches_javascript_vector() {
    // Signer = the controller the hash binds to. Pasted-key shape: the gate itself.
    let signer = addr(0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25);
    let token = addr(0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd);
    let merchant = addr(0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38);
    let calls = array![transfer_call(token, merchant, 5)];
    let outside = OutsideExecution {
        caller: any_caller(),
        nonce: 7,
        execute_after: 1_700_000_000,
        execute_before: 1_700_003_600,
        calls: calls.span(),
    };
    let hash = outside_execution_hash(signer, 'SN_SEPOLIA', @outside);
    // Value printed by: node tools/snip9-vector.mjs
    assert!(
        hash == 0x5f4becd3a2815731f6f378ac9dab8a193bb80a2a4b4b992ddf3703bba66718c,
        "JS and Cairo outside-execution hashes diverged",
    );
}

// ==================================================================
// 36-38. Phase 6 handover: rotating the owner key to the wallet's key.
//
// OpenZeppelin v4.0.1's AccountComponent::set_public_key (embedded in
// GateAccount through PublicKeyImpl) is the entry point the handover uses, and
// it demands TWO proofs — each gets a test here:
//   - assert_only_self: only the gate's own __execute__ may call it, i.e. an
//     owner-signed invoke on the gate itself (t06 already proves a session key
//     can never produce one).
//   - assert_valid_new_owner: the NEW key must sign a raw poseidon hash,
//     poseidon('StarkNet Message', 'accept_ownership', gate, current_owner_pub)
//     (account.cairo L329-334). t36 pins that hash against the JavaScript the
//     handover tool signs with; t37 rotates for real and checks who validates
//     afterwards; t38 proves the signature is load-bearing — an owner-signed
//     invoke carrying a STRANGER's accept-ownership signature is refused.
// ==================================================================

// Mirrors assert_valid_new_owner's message hash in OpenZeppelin v4.0.1's
// AccountComponent (packages/account/src/account.cairo L329-334).
fn accept_ownership_hash(account: ContractAddress, current_owner: felt252) -> felt252 {
    PoseidonTrait::new()
        .update_with('StarkNet Message')
        .update_with('accept_ownership')
        .update_with(account)
        .update_with(current_owner)
        .finalize()
}

// ==================================================================
// 36. The accept-ownership hash agrees with the JavaScript the handover tool
//     signs with (tools/accept-ownership-vector.mjs -> the console's own
//     shortStringEncode + @scure/starknet poseidonHashMany, themselves pinned
//     to starknet.js as oracle in typed-data.test.mjs).
//     Chain: contract == Cairo mirror == JS == starknet.js.
//     The vector uses the Sepolia fixture values on purpose — it pins hash
//     maths, not live state, so it must never change when the owner rotates.
// ==================================================================
#[test]
fn t36_accept_ownership_hash_matches_javascript_vector() {
    let gate = addr(0x7d1d8cad365390adfb2f4f9f89277663c555d2eed790f1c4983c44a002570f1);
    let current_owner = 0x3166ad27f1bedee6af7520d71ee60e1bb3719ab2d26d52fc7fdfc5a3cb4fed0;
    let hash = accept_ownership_hash(gate, current_owner);
    // Value printed by: node tools/accept-ownership-vector.mjs
    assert!(
        hash == 0x10a910c44899be4514cd5705279c4664852097bcb35a1e75eb3fd844a7ae720,
        "JS and Cairo accept-ownership hashes diverged",
    );
}

// ==================================================================
// 37. The real rotation: an owner-signed invoke on the gate itself, carrying
//     set_public_key(new_pub, [r, s]) where [r, s] is the NEW key's signature
//     over the accept-ownership hash. Afterwards the chain names the new key,
//     the new key validates signatures, and the OLD key — the pasted key, whose
//     last act this invoke was — no longer does.
// ==================================================================
#[test]
fn t37_owner_rotates_key_with_accept_ownership_signature() {
    let env = setup();
    let new_owner = StarkCurveKeyPairImpl::from_secret_key('wallet_key');

    let hash = accept_ownership_hash(env.account, env.owner.public_key);
    let (r, s) = new_owner.sign(hash).unwrap();
    let calldata = array![new_owner.public_key, 2, r, s];
    let calls = array![
        Call { to: env.account, selector: selector!("set_public_key"), calldata: calldata.span() },
    ];
    owner_execute(env, calls.span());

    let keys = IPublicKeyDispatcher { contract_address: env.account };
    assert!(keys.get_public_key() == new_owner.public_key, "the owner key did not rotate");

    let src6 = ISRC6Dispatcher { contract_address: env.account };
    let (nr, ns) = new_owner.sign('a message').unwrap();
    assert!(
        src6.is_valid_signature('a message', array![nr, ns]) == VALIDATED,
        "the new key must validate signatures",
    );
    let (or, os) = env.owner.sign('a message').unwrap();
    assert!(
        src6.is_valid_signature('a message', array![or, os]) == 0,
        "the replaced key must stop validating - it is no longer the owner",
    );
}

// ==================================================================
// 38. The accept-ownership signature is load-bearing: the caller proof alone —
//     an owner-signed invoke, the one thing t06 shows a session key can never
//     produce — is NOT enough. A stranger's signature over the correct hash is
//     refused by the contract itself: the new key must prove it controls the
//     key it is being handed, or the account would be locked by a typo.
// ==================================================================
#[test]
// Two ENTRYPOINT_FAILED wrappers, not one: the inner self-call (__execute__ ->
// set_public_key) fails with OZ's own message, and the dispatcher's call into
// __execute__ wraps that failure again. Observed verbatim from snforge 0.64.1.
#[should_panic(
    expected: ('Account: invalid signature', 'ENTRYPOINT_FAILED', 'ENTRYPOINT_FAILED')
)]
fn t38_rotation_refused_without_the_new_keys_signature() {
    let env = setup();
    let new_owner = StarkCurveKeyPairImpl::from_secret_key('wallet_key');
    let stranger = StarkCurveKeyPairImpl::from_secret_key('stranger_key');

    let hash = accept_ownership_hash(env.account, env.owner.public_key);
    let (r, s) = stranger.sign(hash).unwrap(); // right hash, WRONG key
    let calldata = array![new_owner.public_key, 2, r, s];
    let calls = array![
        Call { to: env.account, selector: selector!("set_public_key"), calldata: calldata.span() },
    ];
    owner_execute(env, calls.span());
}

// ==================================================================
// 39-41. v0.4 owner-level guard: the registered controller may call admin
//     entrypoints DIRECTLY (OBS-32/33). Ready X rehearses SNIP-9 messages from
//     the wallet at signing time, so a self-only guard froze every wallet-signed
//     admin action; admitting the controller — the owner's signing identity —
//     makes the rehearsal truthful without adding privilege (SNIP-9 already gave
//     the controller's signature whatever the owner may do). The outsider panic
//     stays byte-identical: t30/t33 still pin 'Account: unauthorized' for callers
//     that are neither the gate nor the controller, and t41 pins the same tuple
//     when NO controller is registered at all.
// ==================================================================
#[test]
fn t39_controller_sets_spending_policy_directly_v04() {
    let env = setup();
    let controller = addr('controller');
    register_controller(env, controller);

    cheat_caller_address(env.account, controller, CheatSpan::TargetCalls(1));
    policy_dispatcher(env).set_spending_policy(env.session.public_key, env.token, 100, 100, 30);

    let policy = policy_dispatcher(env).get_spending_policy(env.session.public_key, env.token);
    assert!(policy.max_per_call == 100, "controller-set policy did not land");
    assert!(policy.max_per_window == 100, "controller-set window cap did not land");
}

#[test]
fn t40_controller_upgrades_in_place_v04() {
    let env = setup();
    let controller = addr('controller');
    register_controller(env, controller);

    let class = declare_class("GateAccount");
    cheat_caller_address(env.account, controller, CheatSpan::TargetCalls(1));
    IUpgradeProbeDispatcher { contract_address: env.account }.upgrade(class.class_hash);

    // The migration promise holds through the controller path too: state survives.
    assert!(
        controller_dispatcher(env).get_wallet_controller() == controller,
        "controller-path upgrade must preserve state",
    );
}

#[test]
#[should_panic(expected: ('Account: unauthorized', 'ENTRYPOINT_FAILED'))]
fn t41_direct_admin_call_with_no_controller_registered_still_rejected_v04() {
    let env = setup();
    // NO register_controller here: with controller == 0 the v0.4 branch admits
    // nobody, so a direct admin call is still the pinned outsider panic.
    cheat_caller_address(env.account, addr('controller'), CheatSpan::TargetCalls(1));
    policy_dispatcher(env).set_spending_policy(env.session.public_key, env.token, 100, 100, 30);
}
