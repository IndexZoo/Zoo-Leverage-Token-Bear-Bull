import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2LendingPool} from "@setprotocol/set-protocol-v2/typechain/AaveV2LendingPool";

import {ether, approx, preciseMul} from "../utils/helpers";

import "./types";
import { Context } from "./context";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_INT_256, MAX_UINT_256 } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "./BalanceTracker";

import {initUniswapRouter} from "./context";
import { WETH9 } from "@typechain/WETH9";
import { BigNumber, Wallet } from "ethers";
import { UniswapV2Router02 } from "@setprotocol/set-protocol-v2/typechain/UniswapV2Router02";
import { SetToken } from "@typechain/SetToken";
chai.use(solidity);
chai.use(approx);


// TODO: Sequence:   how to redeem all <- how to delever properly (account for swap fees)

// Notes: 
// In order to repay debt check withdrawable > debt`
//    - then withdraw debt` = amountIn(weth, debtAmount) = collateralAmountToWithdraw 
///   - else withdraw the allowed withdrawable then pay all withdrawable for part of debt


describe("Testing Ecosystem", function () {
  let ctx: Context;
  let bob: Account;
  let alice: Account;
  let owner: Account;
  let weth: WETH9;
  let dai: StandardTokenMock;
  let daiTracker: BalanceTracker;
    beforeEach("", async () => {
      ctx = new Context();
      await ctx.initialize();
      bob = ctx.accounts.bob;
      owner = ctx.accounts.owner;
      alice = ctx.accounts.alice;
      weth = ctx.tokens.weth as WETH9;
      dai = ctx.tokens.dai;
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
        expect(assets[0]).to.be.eq(ctx.tokens.weth.address);
        expect(assets[1]).to.be.eq(ctx.tokens.btc.address);
      });
    });
   
    it("router -- xx ", async function () {
      let configs = await ctx.subjectModule!.configs(ctx.sets[0].address);
      expect(configs.router).to.be.eq(ctx.router!.address) ;
      expect(configs.quote).to.be.eq(ctx.tokens.dai.address) ;
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
        price: number = 1000
      ) => {
        let holdersWeth = await weth.balanceOf(holder.address);
        await approveAndDeposit(weth, holder, holdersWeth );
        await aaveLender.connect(holder.wallet).borrow(dai.address, holdersWeth.mul(price).mul(borrowPortion).div(ether(1)), 2, 0, holder.address);
        await router.connect(holder.wallet).swapExactTokensForTokens(
          holdersWeth.mul(price).mul(borrowPortion).div(ether(1)), 
          0, 
          [dai.address, weth.address],
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
        await weth.connect(alice.wallet).deposit({value: ether(0.1)});
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
    describe.only("AaveLeverageModule", async function() {
      let aaveLender: AaveV2LendingPool;
      let zToken: SetToken;
      let aWethTracker: BalanceTracker;
      beforeEach("", async function(){
        aaveLender = ctx.aaveFixture.lendingPool;
        zToken = ctx.sets[1];
        aWethTracker = new BalanceTracker(ctx.aTokens.aWeth);
      });
      it("Verify AaveLeverageModule & IssuanceModule are hooked to SetToken", async function() {
        let modules = await zToken.getModules();
        expect(modules).to.contain(ctx.ct.aaveLeverageModule.address);
        expect(modules).to.contain(ctx.ct.issuanceModule.address);
        expect(modules).to.contain(ctx.ct.streamingFee.address);
      });
      it("Issue 1 Z", async function() {
        let quantity = ether(1);
        let ltv = ether(0.8);
        let price = 1000;
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        
        await weth.connect(bob.wallet).approve(aaveLender.address, quantity);
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await aaveLender.connect(bob.wallet).deposit(weth.address, quantity, bob.address, 0);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        expect(aWethTracker.lastSpent(bob.address)).to.be.eq(quantity);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq( quantity );

        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ltv.mul(price),
          preciseMul(ltv, ether(0.9)),
          "UNISWAP",
          "0x"
        );
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(preciseMul( quantity, ltv));
      });

      it("Issue then verify redeem of 1 Z", async function() {
        let quantity = ether(1);
        await weth.connect(bob.wallet).approve(aaveLender.address, quantity);
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aaveLender.connect(bob.wallet).deposit(weth.address, quantity, bob.address, 0);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, quantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);

        expect(aWethTracker.lastSpent(zToken.address)).to.be.eq(quantity);
        expect(aWethTracker.lastEarned(bob.address)).to.be.eq(quantity);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.eq(ether(0));
      });

      it("Issue then verify redeem part of it without lever ", async function() {
        let quantity = ether(1);
        let redeemQuantity = ether(0.55);
        await weth.connect(bob.wallet).approve(aaveLender.address, quantity);
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aaveLender.connect(bob.wallet).deposit(weth.address, quantity, bob.address, 0);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemQuantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);

        expect(aWethTracker.lastSpent(zToken.address)).to.be.eq(redeemQuantity);
        expect(aWethTracker.lastEarned(bob.address)).to.be.eq(redeemQuantity);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.eq(quantity.sub(redeemQuantity));
      });



      it("Sync -- verify sync produces the proper positionUnit", async function() {
        let quantity = ether(1);
        let positionUnit = ether(1);
        await weth.connect(bob.wallet).approve(aaveLender.address, quantity);
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aaveLender.connect(bob.wallet).deposit(weth.address, quantity, bob.address, 0);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);

        expect(await zToken.getDefaultPositionRealUnit(ctx.aTokens.aWeth.address)).to.be.eq(positionUnit);

        await ctx.ct.aaveLeverageModule.sync(zToken.address);
        expect(await zToken.getDefaultPositionRealUnit(ctx.aTokens.aWeth.address)).to.be.eq(positionUnit);
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );
        await ctx.ct.aaveLeverageModule.sync(zToken.address);
        let assets = await ctx.ct.aaveLeverageModule.getEnabledAssets(zToken.address);
        expect(await zToken.getDefaultPositionRealUnit(ctx.aTokens.aWeth.address)).to.be.approx(positionUnit);

        // Issuers win  -- price of weth increase
        let newDaiPrice  = ether(0.001).div(2);
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, newDaiPrice);
        await ctx.ct.aaveLeverageModule.sync(zToken.address);
        expect(await zToken.getDefaultPositionRealUnit(ctx.aTokens.aWeth.address)).to.be.approx(ether(1.4));
       
        // Issuers lose  -- price of weth decrease
        newDaiPrice  = ether(0.001).mul(2);
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, newDaiPrice);
        await ctx.ct.aaveLeverageModule.sync(zToken.address);
        expect(await zToken.getDefaultPositionRealUnit(ctx.aTokens.aWeth.address)).to.be.approx(ether(0.2));

      });

      it.only("Issue then verify redeem of 1 Z after leveraging", async function() {
        // redeem the withdrawable portion
        // TODO: TODO: investigate Lever adding a position for debt (or aDebt)
        let quantity = ether(1);
        let redeemable = ether(0.2);
        await weth.connect(bob.wallet).approve(aaveLender.address, quantity);
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aaveLender.connect(bob.wallet).deposit(weth.address, quantity, bob.address, 0);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );
        console.log(await zToken.getPositions());
        await aWethTracker.pushMultiple([bob.address, zToken.address]);

        // can't transfer debt from redeemer to zToken, hence changed default logic of setprotocol
        console.log("dai address ", dai.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address);
        // await aWethTracker.pushMultiple([bob.address, zToken.address]);
        // console.log(aWethTracker.lastSpent(zToken.address));
        // console.log(aWethTracker.lastEarned(bob.address));
        // console.log(aWethTracker.totalEarned(zToken.address));

      });


      it.skip("Issue then verify redeem of 1 Z after leveraging", async function() {
        let quantity = ether(1);
        await weth.connect(bob.wallet).approve(aaveLender.address, quantity);
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aaveLender.connect(bob.wallet).deposit(weth.address, quantity, bob.address, 0);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        // FIXME: need change , can't transfer debt from redeemer to zToken

        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, quantity, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        expect(aWethTracker.lastSpent(zToken.address)).to.be.eq(quantity.add(ether(0.8)));
        expect(aWethTracker.lastEarned(bob.address)).to.be.eq(quantity);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.eq(ether(0));

      });

      it("", async function () {
        console.log(ctx.ct.controller.address);
        console.log(ctx.ct.streamingFee.address);
        console.log(ctx.ct.aaveLeverageModule.address);
        // FIXME: check hooks of AaveLeverageModule

        console.log(ctx.ct.lev3xModuleIssuanceHook.address);
        console.log(await ctx.ct.issuanceModule.getModuleIssuanceHooks(zToken.address));
      });

        // TODO: TODO:  No need for hook / Work on Lev3xIssuanceModule::getIssuanceUnits
        // TODO: TODO:  Test Lever limit / Test delever limit (lever twice and try delever once)

        // TODO: redeem nav
        // TODO:  resolveDebtPositions by implementing new issuanceModule 
        // - callModulePreredeemHook changes virtualUnit - equityUnits = units-debt , debtUnits=0 - resolve
        // TODO: Multiple Lever
        // TODO: test with price change 
        // TODO: streamfees
        // TODO: Rebalance
    });
 
});