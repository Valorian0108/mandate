//! Test-only mock ERC-20.
//!
//! This lives in the contract target (not in `tests/`) because snforge can only
//! `declare` contract classes that belong to a `starknet-contract` build target.
//! It implements the canonical ERC-20 `transfer` ABI — calldata layout
//! `[recipient, amount_low, amount_high]` — which is exactly what GateAccount's
//! spending enforcement parses in `enforce_spending`.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IERC20Mock<TContractState> {
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
}

#[starknet::contract]
pub mod ERC20Mock {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::ContractAddress;
    use super::IERC20Mock;

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, holder: ContractAddress, supply: u256) {
        self.balances.write(holder, supply);
    }

    #[abi(embed_v0)]
    impl ERC20MockImpl of IERC20Mock<ContractState> {
        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let sender = starknet::get_caller_address();
            let sender_balance = self.balances.read(sender);
            assert!(sender_balance >= amount, "ERC20Mock: insufficient balance");
            self.balances.write(sender, sender_balance - amount);
            let recipient_balance = self.balances.read(recipient);
            self.balances.write(recipient, recipient_balance + amount);
            true
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }
    }
}

// ----------------------------------------------------------------------
// v0.3 test-only mock wallet controllers (controller-bound SNIP-9).
//
// GateAccount::execute_from_outside_v2 delegates signature verification to the
// registered controller's is_valid_signature (SRC-6 ABI shape, which is exactly
// what OZ's assert_valid_signature calls through ISRC6Dispatcher). These two
// mocks pin both ends of that delegation:
//   - RefusingController: says "not valid" to everything. A PERFECT owner
//     signature still fails — the registered controller's word is law.
//   - RubberStampController: says VALID to everything. A GARBAGE signature
//     passes — proving the contract delegates for real and does not secretly
//     check the owner key locally.
// Choosing a controller is therefore an owner-level trust decision, which is
// exactly the Layer B point: only the owner can make it (assert_only_self +
// admin blocklist), and the choice is recorded on-chain with an event.
// ----------------------------------------------------------------------

#[starknet::contract]
pub mod RefusingController {
    #[storage]
    struct Storage {}

    #[external(v0)]
    fn is_valid_signature(
        self: @ContractState, _hash: felt252, _signature: Array<felt252>,
    ) -> felt252 {
        0
    }
}

#[starknet::contract]
pub mod RubberStampController {
    #[storage]
    struct Storage {}

    #[external(v0)]
    fn is_valid_signature(
        self: @ContractState, _hash: felt252, _signature: Array<felt252>,
    ) -> felt252 {
        starknet::VALIDATED
    }
}
