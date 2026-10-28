// EvidenceRegistry - the on-chain half of Layer D's hybrid evidence model.
//
// The full evidence records live off-chain (they are detailed and private). This
// contract stores only a FINGERPRINT: the Merkle root of an agent's records plus
// the number of records it covers. The chain becomes a witness: if a record is
// edited or deleted later, the root no longer matches.
//
// Design choices, deliberately small:
//   - Anchors are keyed by (agent_id, caller). A caller can only advance its OWN
//     slot, so one witness cannot overwrite or grief another witness's history.
//   - Counts must strictly increase: an anchor is a promise about a prefix of the
//     record list, never a rewrite of an earlier one.
//   - The contract stores no opinion about whether the records are true. Truth
//     comes from signatures: the app signs the facts, the owner signs ladder
//     changes. The chain only proves the fingerprint existed at a point in time.
//
// The owner anchors through the GateAccount (the caller is the account, not the
// owner key), so the anchor is an owner-authorized action like any other.

#[derive(Drop, Copy, Serde, Debug, PartialEq, starknet::Store, Default)]
pub struct Anchor {
    pub root: felt252,
    pub count: u32,
}

#[starknet::interface]
pub trait IEvidenceRegistry<TContractState> {
    fn anchor(ref self: TContractState, agent_id: felt252, root: felt252, count: u32);
    fn get_anchor(
        self: @TContractState, agent_id: felt252, anchorer: starknet::ContractAddress,
    ) -> Anchor;
    fn get_anchor_count(
        self: @TContractState, agent_id: felt252, anchorer: starknet::ContractAddress,
    ) -> u32;
}

#[starknet::contract]
pub mod EvidenceRegistry {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::Anchor;

    #[storage]
    struct Storage {
        anchors: Map<(felt252, ContractAddress), Anchor>,
        anchor_count: Map<(felt252, ContractAddress), u32>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Anchored: Anchored,
    }

    #[derive(Drop, starknet::Event)]
    struct Anchored {
        #[key]
        agent_id: felt252,
        #[key]
        anchorer: ContractAddress,
        root: felt252,
        count: u32,
    }

    #[abi(embed_v0)]
    impl EvidenceRegistryImpl of super::IEvidenceRegistry<ContractState> {
        fn anchor(ref self: ContractState, agent_id: felt252, root: felt252, count: u32) {
            let anchorer = get_caller_address();
            assert(count > 0, 'EvidenceRegistry: empty anchor');
            assert(root != 0, 'EvidenceRegistry: empty root');
            let prev = self.anchors.read((agent_id, anchorer));
            assert(count > prev.count, 'EvidenceRegistry: bad count');
            self.anchors.write((agent_id, anchorer), Anchor { root, count });
            let n = self.anchor_count.read((agent_id, anchorer));
            self.anchor_count.write((agent_id, anchorer), n + 1);
            self.emit(Anchored { agent_id, anchorer, root, count });
        }

        fn get_anchor(
            self: @ContractState, agent_id: felt252, anchorer: ContractAddress,
        ) -> Anchor {
            self.anchors.read((agent_id, anchorer))
        }

        fn get_anchor_count(
            self: @ContractState, agent_id: felt252, anchorer: ContractAddress,
        ) -> u32 {
            self.anchor_count.read((agent_id, anchorer))
        }
    }
}
