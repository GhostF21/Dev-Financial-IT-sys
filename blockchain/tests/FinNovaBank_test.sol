// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Remix "Solidity Unit Testing" plugin test. Remix injects these two files
// automatically, they do not exist on disk.
import "remix_tests.sol";
import "../contracts/FinNovaBank.sol";

/// @dev The test contract itself is the bank customer here (msg.sender seen by
///      the bank). It receives 3 ETH through `#value` and a receive() hook so
///      withdrawals can be paid out to it.
contract FinNovaBankTest {
    FinNovaBank bank;
    address constant BOB = address(0xB0B);

    function beforeAll() public {
        bank = new FinNovaBank();
    }

    /// #value: 1000000000000000000
    function checkDeposit() public payable {
        bank.deposit{value: msg.value}();
        Assert.equal(bank.checkBalance(), 1 ether, "balance should be 1 ETH after deposit");
        Assert.equal(bank.totalDeposits(), 1 ether, "bank should hold 1 ETH");
    }

    function checkWithdraw() public {
        uint256 before = address(this).balance;
        bank.withdraw(0.4 ether);
        Assert.equal(bank.checkBalance(), 0.6 ether, "balance should be 0.6 ETH after withdraw");
        Assert.equal(address(this).balance - before, 0.4 ether, "0.4 ETH should be paid out");
    }

    function checkTransfer() public {
        bank.transfer(BOB, 0.25 ether);
        Assert.equal(bank.checkBalance(), 0.35 ether, "sender balance should be 0.35 ETH");
        Assert.equal(bank.balanceOf(BOB), 0.25 ether, "recipient balance should be 0.25 ETH");
        Assert.equal(bank.totalDeposits(), 0.6 ether, "internal transfer keeps ETH in the bank");
    }

    function checkWithdrawTooMuchFails() public {
        try bank.withdraw(10 ether) {
            Assert.ok(false, "withdrawing more than the balance must revert");
        } catch (bytes memory reason) {
            Assert.equal(
                bytes4(reason),
                FinNovaBank.InsufficientBalance.selector,
                "should revert with InsufficientBalance"
            );
        }
    }

    function checkZeroDepositFails() public {
        try bank.deposit{value: 0}() {
            Assert.ok(false, "zero deposit must revert");
        } catch (bytes memory reason) {
            Assert.equal(bytes4(reason), FinNovaBank.ZeroAmount.selector, "should revert with ZeroAmount");
        }
    }

    function checkTransferToSelfFails() public {
        try bank.transfer(address(this), 1) {
            Assert.ok(false, "self transfer must revert");
        } catch (bytes memory reason) {
            Assert.equal(bytes4(reason), FinNovaBank.SelfTransfer.selector, "should revert with SelfTransfer");
        }
    }

    receive() external payable {}
}
