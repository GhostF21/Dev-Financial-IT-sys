const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const ONE = ethers.parseEther("1");
const HALF = ethers.parseEther("0.5");

describe("FinNovaBank", function () {
  async function deployFixture() {
    const [alice, bob, carol] = await ethers.getSigners();
    const bank = await ethers.deployContract("FinNovaBank");
    await bank.waitForDeployment();
    return { bank, alice, bob, carol };
  }

  describe("deployment", function () {
    it("starts with zero balances and zero total deposits", async function () {
      const { bank, alice } = await loadFixture(deployFixture);
      expect(await bank.checkBalance()).to.equal(0n);
      expect(await bank.balanceOf(alice.address)).to.equal(0n);
      expect(await bank.totalDeposits()).to.equal(0n);
    });
  });

  describe("deposit()", function () {
    it("credits msg.sender, moves ETH into the contract and emits Deposit", async function () {
      const { bank, alice } = await loadFixture(deployFixture);
      const tx = bank.deposit({ value: ONE });
      await expect(tx).to.emit(bank, "Deposit").withArgs(alice.address, ONE, ONE, anyValue);
      await expect(tx).to.changeEtherBalances([alice, bank], [-ONE, ONE]);
      expect(await bank.checkBalance()).to.equal(ONE);
      expect(await bank.totalDeposits()).to.equal(ONE);
    });

    it("accumulates multiple deposits", async function () {
      const { bank, alice } = await loadFixture(deployFixture);
      await bank.deposit({ value: ONE });
      await expect(bank.deposit({ value: HALF }))
        .to.emit(bank, "Deposit")
        .withArgs(alice.address, HALF, ONE + HALF, anyValue);
      expect(await bank.checkBalance()).to.equal(ONE + HALF);
    });

    it("keeps balances separate per address", async function () {
      const { bank, alice, bob } = await loadFixture(deployFixture);
      await bank.connect(alice).deposit({ value: ONE });
      await bank.connect(bob).deposit({ value: HALF });
      expect(await bank.connect(alice).checkBalance()).to.equal(ONE);
      expect(await bank.connect(bob).checkBalance()).to.equal(HALF);
      expect(await bank.totalDeposits()).to.equal(ONE + HALF);
    });

    it("reverts on a zero deposit", async function () {
      const { bank } = await loadFixture(deployFixture);
      await expect(bank.deposit({ value: 0 })).to.be.revertedWithCustomError(bank, "ZeroAmount");
    });

    it("rejects plain ETH sent without deposit()", async function () {
      const { bank, alice } = await loadFixture(deployFixture);
      await expect(alice.sendTransaction({ to: await bank.getAddress(), value: ONE })).to.be.revertedWith(
        "Use deposit()"
      );
    });
  });

  describe("withdraw()", function () {
    it("debits the balance, sends ETH back and emits Withdrawal", async function () {
      const { bank, alice } = await loadFixture(deployFixture);
      await bank.deposit({ value: ONE });
      const tx = bank.withdraw(HALF);
      await expect(tx).to.emit(bank, "Withdrawal").withArgs(alice.address, HALF, HALF, anyValue);
      await expect(tx).to.changeEtherBalances([alice, bank], [HALF, -HALF]);
      expect(await bank.checkBalance()).to.equal(HALF);
    });

    it("allows withdrawing the full balance", async function () {
      const { bank } = await loadFixture(deployFixture);
      await bank.deposit({ value: ONE });
      await bank.withdraw(ONE);
      expect(await bank.checkBalance()).to.equal(0n);
      expect(await bank.totalDeposits()).to.equal(0n);
    });

    it("reverts when withdrawing more than the balance", async function () {
      const { bank } = await loadFixture(deployFixture);
      await bank.deposit({ value: HALF });
      await expect(bank.withdraw(ONE))
        .to.be.revertedWithCustomError(bank, "InsufficientBalance")
        .withArgs(HALF, ONE);
    });

    it("reverts on a zero withdrawal", async function () {
      const { bank } = await loadFixture(deployFixture);
      await expect(bank.withdraw(0)).to.be.revertedWithCustomError(bank, "ZeroAmount");
    });

    it("cannot withdraw another customer's money", async function () {
      const { bank, alice, bob } = await loadFixture(deployFixture);
      await bank.connect(alice).deposit({ value: ONE });
      await expect(bank.connect(bob).withdraw(ONE))
        .to.be.revertedWithCustomError(bank, "InsufficientBalance")
        .withArgs(0n, ONE);
    });

    it("is safe against reentrancy", async function () {
      const { bank } = await loadFixture(deployFixture);
      await bank.deposit({ value: ONE }); // other customers' money an attacker would like to drain
      const attacker = await ethers.deployContract("ReentrancyAttacker", [await bank.getAddress()]);
      // The re-entrant withdraw reverts, so the ETH send fails and the whole attack is rolled back.
      await expect(attacker.attack({ value: HALF })).to.be.revertedWithCustomError(bank, "WithdrawFailed");
      expect(await bank.totalDeposits()).to.equal(ONE);
      expect(await bank.balanceOf(await attacker.getAddress())).to.equal(0n);
    });
  });

  describe("transfer()", function () {
    it("moves balance between addresses inside the bank and emits Transfer", async function () {
      const { bank, alice, bob } = await loadFixture(deployFixture);
      await bank.connect(alice).deposit({ value: ONE });
      const tx = bank.connect(alice).transfer(bob.address, HALF);
      await expect(tx).to.emit(bank, "Transfer").withArgs(alice.address, bob.address, HALF, anyValue);
      // No ETH leaves the contract on an internal transfer.
      await expect(tx).to.changeEtherBalance(bank, 0n);
      expect(await bank.balanceOf(alice.address)).to.equal(HALF);
      expect(await bank.balanceOf(bob.address)).to.equal(HALF);
      expect(await bank.totalDeposits()).to.equal(ONE);
    });

    it("lets the recipient withdraw transferred funds", async function () {
      const { bank, alice, bob } = await loadFixture(deployFixture);
      await bank.connect(alice).deposit({ value: ONE });
      await bank.connect(alice).transfer(bob.address, ONE);
      await expect(bank.connect(bob).withdraw(ONE)).to.changeEtherBalance(bob, ONE);
      expect(await bank.totalDeposits()).to.equal(0n);
    });

    it("reverts when transferring more than the balance", async function () {
      const { bank, alice, bob } = await loadFixture(deployFixture);
      await bank.connect(alice).deposit({ value: HALF });
      await expect(bank.connect(alice).transfer(bob.address, ONE))
        .to.be.revertedWithCustomError(bank, "InsufficientBalance")
        .withArgs(HALF, ONE);
    });

    it("reverts on zero amount, zero address and self transfer", async function () {
      const { bank, alice, bob } = await loadFixture(deployFixture);
      await bank.connect(alice).deposit({ value: ONE });
      await expect(bank.connect(alice).transfer(bob.address, 0)).to.be.revertedWithCustomError(bank, "ZeroAmount");
      await expect(bank.connect(alice).transfer(ethers.ZeroAddress, HALF)).to.be.revertedWithCustomError(
        bank,
        "InvalidRecipient"
      );
      await expect(bank.connect(alice).transfer(alice.address, HALF)).to.be.revertedWithCustomError(
        bank,
        "SelfTransfer"
      );
    });
  });

  describe("history (events)", function () {
    it("records every operation so the history can be rebuilt from logs", async function () {
      const { bank, alice, bob } = await loadFixture(deployFixture);
      await bank.connect(alice).deposit({ value: ONE });
      await bank.connect(alice).transfer(bob.address, HALF);
      await bank.connect(bob).withdraw(HALF);

      const deposits = await bank.queryFilter(bank.filters.Deposit(alice.address));
      const transfersOut = await bank.queryFilter(bank.filters.Transfer(alice.address));
      const transfersIn = await bank.queryFilter(bank.filters.Transfer(null, bob.address));
      const withdrawals = await bank.queryFilter(bank.filters.Withdrawal(bob.address));

      expect(deposits).to.have.length(1);
      expect(deposits[0].args.amount).to.equal(ONE);
      expect(transfersOut).to.have.length(1);
      expect(transfersIn).to.have.length(1);
      expect(transfersIn[0].args.from).to.equal(alice.address);
      expect(withdrawals).to.have.length(1);
      expect(withdrawals[0].args.newBalance).to.equal(0n);
      expect(withdrawals[0].blockNumber).to.be.greaterThan(deposits[0].blockNumber);
    });
  });
});
