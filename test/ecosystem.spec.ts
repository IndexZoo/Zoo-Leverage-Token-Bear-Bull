import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2LendingPool} from "@setprotocol/set-protocol-v2/typechain/AaveV2LendingPool";

import {ether, approx, preciseMul, bitcoin} from "../utils/helpers";

import "../utils/test/types";
import { Context } from "../utils/test/context";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_INT_256, MAX_UINT_256 } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "../utils/test/BalanceTracker";

import {initUniswapRouter} from "../utils/test/context";
import { WETH9 } from "@typechain/WETH9";
import { BigNumber, Wallet } from "ethers";
import { UniswapV2Router02 } from "@setprotocol/set-protocol-v2/typechain/UniswapV2Router02";
import { SetToken } from "@typechain/SetToken";
import {AaveV2AToken} from "@setprotocol/set-protocol-v2/dist/utils/contracts/aaveV2";

chai.use(solidity);
chai.use(approx);


// Notes: 
// In order to repay debt check withdrawable > debt`
//    - then withdraw debt` = amountIn(weth, debtAmount) = collateralAmountToWithdraw 
///   - else withdraw the allowed withdrawable then pay all withdrawable for part of debt

const advanceTime = async (duration: number): Promise<void> => {
  await ethers.provider.send('evm_increaseTime', [duration*3600*24*365.25]); // duration in years 
};

describe("Testing Ecosystem", function () {
  let ctx: Context;
  let bob: Account;
  let alice: Account;
  let owner: Account;
  let weth: WETH9;
  let dai: StandardTokenMock;
  let daiTracker: BalanceTracker;
  let btc: StandardTokenMock;
    beforeEach("", async () => {
      ctx = new Context();
      await ctx.initialize(false);  // 
      bob = ctx.accounts.bob;
      owner = ctx.accounts.owner;
      alice = ctx.accounts.alice;
      weth = ctx.tokens.weth as WETH9;
      dai = ctx.tokens.dai;
      btc = ctx.tokens.btc;
      daiTracker = new BalanceTracker(dai);
    });
    describe("SetProtocol", async function () {
      it("Created Set", async function () {
        let sToken = ctx.sets[0];
        expect(sToken.address).to.be.not.eq(ADDRESS_ZERO);
      });
      it("Get Components", async function () {
        let sToken = ctx.sets[0];
        let assets = await sToken.getComponents();
        expect(assets[0]).to.be.eq(ctx.aTokens.aWeth.address);
        expect(assets.length).to.be.equal(1);
      });
    });
   

    describe("Uniswap", async function() {
      it("real router", async function() {
        let amountIn = ether(0.1);
        let router = await initUniswapRouter(ctx.accounts.owner, ctx.tokens.weth, ctx.tokens.dai, ctx.tokens.btc);
        let amounts = await router.getAmountsOut(amountIn, [ctx.tokens.weth.address, ctx.tokens.dai.address]);
        expect(amounts[1]).to.be.approx(amountIn.mul(1000));
      });
    });

    describe("Aave", async function() {
      let aaveFixture: AaveV2Fixture;
      let aaveLender: AaveV2LendingPool;
      let router: UniswapV2Router02;
      let approveAndDeposit = async (
        token: StandardTokenMock | WETH9, 
        account: Account, 
        amount: BigNumber
        ) => 
        {
          await token.connect(account.wallet).approve(aaveLender.address, amount);
          await aaveLender.connect(account.wallet).deposit(token.address, amount, account.address, 0);       
        };
      let depositBorrowSwap = async (
        holder: Account,
        borrowPortion: BigNumber,   // ether ratio 
        price: number = 1000,
        token: StandardTokenMock | WETH9 | undefined = weth
      ) => {
        let holdersWeth = await token.balanceOf(holder.address);
        await approveAndDeposit(token, holder, holdersWeth );
        await aaveLender.connect(holder.wallet).borrow(dai.address, holdersWeth.mul(price).mul(borrowPortion).div(ether(1)), 2, 0, holder.address);
        await router.connect(holder.wallet).swapExactTokensForTokens(
          holdersWeth.mul(price).mul(borrowPortion).div(ether(1)), 
          0, 
          [dai.address, token.address],
          holder.address,
          MAX_UINT_256
        );
      };
      beforeEach("", async function(){
        router = await initUniswapRouter(ctx.accounts.owner, ctx.tokens.weth, ctx.tokens.dai, ctx.tokens.btc);
        aaveFixture = new AaveV2Fixture(ethers.provider, owner.address) as AaveV2Fixture;
        await aaveFixture.initialize(weth.address, dai.address);
        aaveLender = aaveFixture.lendingPool;

        await approveAndDeposit(dai, owner, ether(20000));
        await approveAndDeposit(weth, owner, ether(20));
      });
      // TODO: Aave flashloan tests - introduce a mock contract for that
      it("aave lending pool", async function() {
        expect(aaveLender.address).not.eq(ADDRESS_ZERO);
      });
      it("aave deposit borrow then estimate health factor", async function(){
        await approveAndDeposit(weth, bob, ether(1));
        await aaveLender.connect(bob.wallet).borrow(dai.address, ether(800), 2, 0, bob.address);
        let bobStatus = await aaveLender.getUserAccountData(bob.address);
        expect(bobStatus.availableBorrowsETH).to.be.eq(0);
        expect(bobStatus.healthFactor).to.be.approx(ether(1), 0.035);  // healthFactor <= 1 ∓ 0.035
        expect(bobStatus.healthFactor).to.be.gt(ether(1));
      });
      it("aave deposit borrow then advance time to check interest", async function(){
        await approveAndDeposit(weth, bob, ether(1));
        await approveAndDeposit(weth, alice, ether(5));
        await aaveLender.connect(bob.wallet).borrow(dai.address, ether(700), 2, 0, bob.address);
        let bobStatus = await aaveLender.getUserAccountData(bob.address);
        let initBobDebt = bobStatus.totalDebtETH;
        let initBobHF = bobStatus.healthFactor;  // 

        await advanceTime(10);  // advance 10 years in time
        await aaveLender.connect(bob.wallet).borrow(dai.address, ether(50), 2, 0, bob.address);
        await aaveLender.connect(alice.wallet).borrow(dai.address, ether(2000), 2, 0, alice.address);
        bobStatus = await aaveLender.getUserAccountData(bob.address);
        let finalBobDebt = bobStatus.totalDebtETH;
        let finalBobHF = bobStatus.healthFactor;  // 

        expect(finalBobDebt).to.be.gt(initBobDebt);
        expect(finalBobHF).to.be.lt(initBobHF);

        // Reverted with "11": "not enough collateral to cover borrow";
          // - Bob should have a total of ether(800) of dai to borrow
          // - because of borrow fees incurred on Bob's debt, can no longer borrow amount previously available
        await expect(
          aaveLender.connect(bob.wallet).borrow(dai.address, ether(50), 2, 0, bob.address)
        ).to.be.revertedWith("11");
      });
      it("aave double deporrows then estimate healthFactor", async function(){
        let price  = 1000;
        await dai.connect(bob.wallet).approve(router.address, MAX_UINT_256);
        await weth.connect(bob.wallet).transfer (owner.address, (await weth.balanceOf(bob.address)).sub(ether(0.1)));
        // Deposit - Borrow - swap
        await depositBorrowSwap(bob, ether(0.8));  // borrow ~ 0.08   (i.e. in ETH)
        await depositBorrowSwap(bob, ether(0.79));  // borrow ~ 0.064 -> total ~ 0.144  // 0.79 Compensate for swap imperfections 
        await approveAndDeposit(weth, bob, await weth.balanceOf(bob.address));

        let estimatedHealthFactor = ether(2.44).mul(price).mul(ether(0.8)).div(ether(1440));
      
        let bobStatus = await aaveLender.getUserAccountData(bob.address);
        expect(bobStatus.healthFactor).to.be.approx(estimatedHealthFactor, 0.035);
      });
      /**
       * Checking two paths for deporrows
       * Assert that two paths endup with same healthFactor
       * path1: -max utilization-
       * borrow 800 dai -> 640 dai
       * borrow 720 dai -> 540 dai -> 180 dai
       * NB: using uniswap incurs fees
       */
      it("aave deposit borrow then estimate health factor", async function(){
        // Bob's process 
        // Giveaway all weth and keep only 0.1
        await dai.connect(bob.wallet).approve(router.address, MAX_UINT_256);
        await weth.connect(bob.wallet).transfer (owner.address, (await weth.balanceOf(bob.address)).sub(ether(0.1)));
        // Deposit - Borrow - swap
        await depositBorrowSwap(bob, ether(0.8));  // borrow ~ 0.08   (i.e. in ETH)
        await depositBorrowSwap(bob, ether(0.79));  // borrow ~ 0.064 -> total ~ 0.144  // 0.79 Compensate for swap imperfections 
        await approveAndDeposit(weth, bob, await weth.balanceOf(bob.address));
      
        let bobStatus = await aaveLender.getUserAccountData(bob.address);
        
        // Alice's process 
        await dai.connect(alice.wallet).approve(router.address, MAX_UINT_256);
        await weth.connect(alice.wallet).transfer (owner.address, (await weth.balanceOf(alice.address)).sub(ether(0.1)));
        // Deposit - Borrow - swap
        await depositBorrowSwap(alice, ether(0.72));  // borrow ~ 0.072
        await depositBorrowSwap(alice, ether(0.75));  // borrow ~ 0.054 -> total ~ 0.126
        await depositBorrowSwap(alice, ether(0.333333));  // borrow ~ 0.018 -> total ~ 0.144
        await approveAndDeposit(weth, alice, await weth.balanceOf(alice.address));
        let aliceStatus = await aaveLender.getUserAccountData(alice.address);
        
        
        expect(aliceStatus.healthFactor).to.be.approx(bobStatus.healthFactor);
        expect(aliceStatus.availableBorrowsETH).to.be.approx(bobStatus.availableBorrowsETH);
        expect(aliceStatus.totalCollateralETH).to.be.approx(bobStatus.totalCollateralETH);

      });
    });
    describe("Aave tokens ",  async function () {
      let aaveFixture: AaveV2Fixture;
      let aaveLender: AaveV2LendingPool;
      let router: UniswapV2Router02;
      let aBtc: AaveV2AToken;
      let approveAndDeposit = async (
        token: StandardTokenMock | WETH9, 
        account: Account, 
        amount: BigNumber
        ) => 
        {
          await token.connect(account.wallet).approve(aaveLender.address, amount);
          await aaveLender.connect(account.wallet).deposit(token.address, amount, account.address, 0);       
        };
      let depositBorrowSwap = async (
        holder: Account,
        borrowPortion: BigNumber,   // ether ratio 
        price: number = 1000,
        token: StandardTokenMock | WETH9 | undefined = weth
      ) => {
        let holdersWeth = await token.balanceOf(holder.address);
        await approveAndDeposit(token, holder, holdersWeth );
        await aaveLender.connect(holder.wallet).borrow(dai.address, holdersWeth.mul(price).mul(borrowPortion).div(ether(1)), 2, 0, holder.address);
        await router.connect(holder.wallet).swapExactTokensForTokens(
          holdersWeth.mul(price).mul(borrowPortion).div(ether(1)), 
          0, 
          [dai.address, token.address],
          holder.address,
          MAX_UINT_256
        );
      };

      beforeEach ("" , async function () {
        await btc.transfer(bob.address, bitcoin(10));
        aBtc = ctx.aTokens.aBtc;
        aaveFixture = ctx.aaveFixture;
        aaveLender = aaveFixture.lendingPool;
      });

      it("Verify aBtc is configured", async function () {
        expect(await aBtc.decimals()).to.be.eq(BigNumber.from(8));
      });

      it("Deposit btc and verify correct aBtc amount received", async function () {
        let quantity = bitcoin(0.2);
        // Deposit 0.2 btc  = 0.2e8
        await approveAndDeposit(btc, bob, quantity); 
        expect(await aBtc.balanceOf(bob.address)).to.be.eq(quantity);
      });

      it("Deposit btc and verify correct borrow amount allowed", async function () {
        let quantity = bitcoin(0.2);
        let borrowPortion = ether(0.8);
        let price = 10000;   // price of 1 btc vs dai
        let borrowAmount = quantity.mul(price).mul(borrowPortion).div(bitcoin(1));
        // Deposit 0.2 btc  = 0.2e8
        await approveAndDeposit(btc, bob, quantity);
        await daiTracker.push(bob.address);
        await aaveLender.connect(bob.wallet).borrow(dai.address, borrowAmount , 2, 0, bob.address);
        await daiTracker.push(bob.address);
        
        expect(await aBtc.balanceOf(bob.address)).to.be.eq(quantity);
        expect(daiTracker.lastEarned(bob.address)).to.be.eq(borrowAmount);
      });
    });
});