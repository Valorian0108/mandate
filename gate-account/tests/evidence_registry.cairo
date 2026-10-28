// EvidenceRegistry tests: the fingerprint contract is small, so the tests focus on
// the properties that make it a witness rather than a database:
//   - an anchor reads back exactly as written;
//   - a count can only move forward (no rewriting an earlier history);
//   - each caller has its own slot (no cross-witness overwriting);
//   - empty roots and empty counts are refused.

use gate_account::evidence_registry::{
    Anchor, IEvidenceRegistryDispatcher, IEvidenceRegistryDispatcherTrait,
};
use snforge_std::{
    CheatSpan, ContractClass, ContractClassTrait, DeclareResult, cheat_caller_address, declare,
};
use starknet::ContractAddress;

fn declare_registry() -> ContractClass {
    match declare("EvidenceRegistry") {
        Result::Ok(result) => match result {
            DeclareResult::Success(class) => class,
            DeclareResult::AlreadyDeclared(class) => class,
        },
        Result::Err(_) => panic!("could not declare EvidenceRegistry"),
    }
}

fn deploy_registry() -> ContractAddress {
    match declare_registry().deploy(@array![]) {
        Result::Ok((address, _)) => address,
        Result::Err(_) => panic!("could not deploy EvidenceRegistry"),
    }
}

fn addr(value: felt252) -> ContractAddress {
    value.try_into().unwrap()
}

fn alice() -> ContractAddress {
    addr('alice')
}

fn bob() -> ContractAddress {
    addr('bob')
}

#[test]
fn anchor_reads_back_exactly() {
    let registry = deploy_registry();
    let dispatcher = IEvidenceRegistryDispatcher { contract_address: registry };
    let agent = 'agent-1';
    let root = 0x1234;
    cheat_caller_address(registry, alice(), CheatSpan::TargetCalls(1));
    dispatcher.anchor(agent, root, 3);

    let anchor: Anchor = dispatcher.get_anchor(agent, alice());
    assert!(anchor.root == root, "root should read back");
    assert!(anchor.count == 3, "count should read back");
    assert!(dispatcher.get_anchor_count(agent, alice()) == 1, "one anchor");
}

#[test]
fn count_only_moves_forward() {
    let registry = deploy_registry();
    let dispatcher = IEvidenceRegistryDispatcher { contract_address: registry };
    let agent = 'agent-1';
    cheat_caller_address(registry, alice(), CheatSpan::TargetCalls(2));
    dispatcher.anchor(agent, 0x1111, 3);
    dispatcher.anchor(agent, 0x2222, 5);

    let anchor: Anchor = dispatcher.get_anchor(agent, alice());
    assert!(anchor.root == 0x2222, "latest root");
    assert!(anchor.count == 5, "latest count");
    assert!(dispatcher.get_anchor_count(agent, alice()) == 2, "two anchors");
}

#[test]
#[should_panic(expected: 'EvidenceRegistry: bad count')]
fn rewriting_the_same_count_is_refused() {
    let registry = deploy_registry();
    let dispatcher = IEvidenceRegistryDispatcher { contract_address: registry };
    let agent = 'agent-1';
    cheat_caller_address(registry, alice(), CheatSpan::TargetCalls(2));
    dispatcher.anchor(agent, 0x1111, 3);
    dispatcher.anchor(agent, 0x2222, 3);
}

#[test]
#[should_panic(expected: 'EvidenceRegistry: bad count')]
fn going_backwards_is_refused() {
    let registry = deploy_registry();
    let dispatcher = IEvidenceRegistryDispatcher { contract_address: registry };
    let agent = 'agent-1';
    cheat_caller_address(registry, alice(), CheatSpan::TargetCalls(2));
    dispatcher.anchor(agent, 0x1111, 5);
    dispatcher.anchor(agent, 0x2222, 4);
}

#[test]
fn each_caller_has_its_own_slot() {
    let registry = deploy_registry();
    let dispatcher = IEvidenceRegistryDispatcher { contract_address: registry };
    let agent = 'agent-1';
    cheat_caller_address(registry, alice(), CheatSpan::TargetCalls(1));
    dispatcher.anchor(agent, 0xaaaa, 3);
    cheat_caller_address(registry, bob(), CheatSpan::TargetCalls(1));
    dispatcher.anchor(agent, 0xbbbb, 9);

    let a: Anchor = dispatcher.get_anchor(agent, alice());
    let b: Anchor = dispatcher.get_anchor(agent, bob());
    assert!(a.root == 0xaaaa, "alice root");
    assert!(a.count == 3, "alice count");
    assert!(b.root == 0xbbbb, "bob root");
    assert!(b.count == 9, "bob count");
}

#[test]
#[should_panic(expected: 'EvidenceRegistry: empty root')]
fn empty_root_is_refused() {
    let registry = deploy_registry();
    let dispatcher = IEvidenceRegistryDispatcher { contract_address: registry };
    cheat_caller_address(registry, alice(), CheatSpan::TargetCalls(1));
    dispatcher.anchor('agent-1', 0, 1);
}

#[test]
#[should_panic(expected: 'EvidenceRegistry: empty anchor')]
fn empty_count_is_refused() {
    let registry = deploy_registry();
    let dispatcher = IEvidenceRegistryDispatcher { contract_address: registry };
    cheat_caller_address(registry, alice(), CheatSpan::TargetCalls(1));
    dispatcher.anchor('agent-1', 0x1234, 0);
}
