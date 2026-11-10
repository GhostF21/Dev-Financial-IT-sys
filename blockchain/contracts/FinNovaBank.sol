// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title FinNova Bank - a minimal on-chain bank account (Lab 10)
/// @notice Every address gets an internal ETH balance. Users can deposit ETH,
///         withdraw it again, send part of their balance to another address
///         inside the bank, and check their balance. Every operation emits an
///         event, so the full history can be read back from the chain.
/// @dev No external imports so the file compiles as-is in Remix IDE.
///      Withdrawals follow checks-effects-interactions and a simple
///      reentrancy lock.
contract FinNovaBank {
    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @dev Internal balance of each customer, in wei.
    mapping(address => uint256) private balances;

    /// @dev Reentrancy lock: 1 = unlocked, 2 = locked.
    uint256 private locked = 1;

    // ------------------------------------------------------------------
    // Events (the on-chain transaction history)
    // ------------------------------------------------------------------

    event Deposit(address indexed account, uint256 amount, uint256 newBalance, uint256 timestamp);
    event Withdrawal(address indexed account, uint256 amount, uint256 newBalance, uint256 timestamp);
    event Transfer(address indexed from, address indexed to, uint256 amount, uint256 timestamp);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    /// @notice The amount must be greater than zero.
    error ZeroAmount();
    /// @notice The caller's bank balance is lower than the requested amount.
    error InsufficientBalance(uint256 available, uint256 requested);
    /// @notice Transfers to the zero address are not allowed.
    error InvalidRecipient();
    /// @notice Transfers to yourself are not allowed.
    error SelfTransfer();
    /// @notice Sending ETH back to the caller failed.
    error WithdrawFailed();
    /// @notice A reentrant call was detected.
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    // ------------------------------------------------------------------
    // Operations
    // ------------------------------------------------------------------

    /// @notice Deposit ETH (set the "Value" field in Remix) into your bank balance.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value, balances[msg.sender], block.timestamp);
    }

    /// @notice Withdraw `amount` wei from your bank balance back to your wallet.
    function withdraw(uint256 amount) external nonReentrant {
        // Checks
        if (amount == 0) revert ZeroAmount();
        uint256 available = balances[msg.sender];
        if (available < amount) revert InsufficientBalance(available, amount);

        // Effects
        balances[msg.sender] = available - amount;
        emit Withdrawal(msg.sender, amount, balances[msg.sender], block.timestamp);

        // Interactions
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @notice Move `amount` wei of your bank balance to `to` (stays inside the bank).
    function transfer(address to, uint256 amount) external {
        if (to == address(0)) revert InvalidRecipient();
        if (to == msg.sender) revert SelfTransfer();
        if (amount == 0) revert ZeroAmount();
        uint256 available = balances[msg.sender];
        if (available < amount) revert InsufficientBalance(available, amount);

        balances[msg.sender] = available - amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount, block.timestamp);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Your own bank balance in wei.
    function checkBalance() external view returns (uint256) {
        return balances[msg.sender];
    }

    /// @notice Bank balance of any address in wei.
    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    /// @notice Total ETH held by the bank contract (sum of all balances).
    function totalDeposits() external view returns (uint256) {
        return address(this).balance;
    }

    /// @dev Plain ETH sent without calling deposit() is rejected so that
    ///      every wei in the contract belongs to a recorded balance.
    receive() external payable {
        revert("Use deposit()");
    }
}
