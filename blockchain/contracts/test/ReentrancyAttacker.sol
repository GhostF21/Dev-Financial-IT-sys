// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFinNovaBank {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev Test helper only (not part of the lab deliverable): tries to re-enter
///      withdraw() from its receive() hook to prove the bank is reentrancy-safe.
contract ReentrancyAttacker {
    IFinNovaBank public immutable bank;
    uint256 public attackAmount;

    constructor(address bankAddress) {
        bank = IFinNovaBank(bankAddress);
    }

    function attack() external payable {
        attackAmount = msg.value;
        bank.deposit{value: msg.value}();
        bank.withdraw(msg.value);
    }

    receive() external payable {
        // Try to withdraw again while the first withdraw is still running.
        bank.withdraw(attackAmount);
    }
}
