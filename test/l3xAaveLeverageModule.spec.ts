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


        // TODO:  restructure and clean this test
        // TODO: TODO: multi user scenario 
        // TODO: TODO: revise using 0.99
        // TODO: TODO: multiple lever  3x 
        // TODO: TODO: work on other tokens other decimals
        // TODO: bear tokens

// Notes: 
// In order to repay debt check withdrawable > debt`
//    - then withdraw debt` = amountIn(weth, debtAmount) = collateralAmountToWithdraw 
///   - else withdraw the allowed withdrawable then pay all withdrawable for part of debt


describe("Testing Issuance with Aaveleverage", function () {
      let ctx: Context;
      let bob: Account;
      let alice: Account;
      let owner: Account;
      let weth: WETH9;
      let dai: StandardTokenMock;
      let daiTracker: BalanceTracker;
      let aaveLender: AaveV2LendingPool;
      let zToken: SetToken;
      let aWethTracker: BalanceTracker;
      let wethTracker: BalanceTracker;

      beforeEach("", async function(){
        ctx = new Context();
        await ctx.initialize(false);  // TODO: use real uniswap
        bob = ctx.accounts.bob;
        owner = ctx.accounts.owner;
        alice = ctx.accounts.alice;
        weth = ctx.tokens.weth as WETH9;
        dai = ctx.tokens.dai;
        daiTracker = new BalanceTracker(dai);

        aaveLender = ctx.aaveFixture.lendingPool;
        zToken = ctx.sets[1];
        aWethTracker = new BalanceTracker(ctx.aTokens.aWeth);
        wethTracker = new BalanceTracker(ctx.tokens.weth as any as StandardTokenMock);
      });
    describe("One user issue and redeem ", async function() {

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

      it("Issue then verify redeem of 0.75 Z (portion of bob's) balance after leveraging", async function() {
        // redeem the withdrawable portion
        // TODO: TODO: : a test for partial redeem (less than ltv) then a test for full redeem
        //   -- TODO: introduce logic for full redeem in case user requests more redeem than balance
        let quantity = ether(1);
        let redeemable = ether(0.75);    
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

        // can't transfer debt from redeemer to zToken, hence changed default logic of setprotocol
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address);
        await aWethTracker.pushMultiple([bob.address, zToken.address]);
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(redeemable);
        expect(aWethTracker.lastEarned(bob.address)).to.be.approx(redeemable);
        // SetToken received 1 + 0.8 - 0.75
        expect(aWethTracker.totalEarned(zToken.address)).to.be.approx(ether(1.8).sub(redeemable));

      });

      it("Issue then verify redeem of 0.75 Z ( < ltv) after leveraging", async function() {
        let quantity = ether(1);
        let redeemable = ether(0.75);  //   
        let fee  =  ether(0.05);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(quantity.sub(redeemable));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity.sub(redeemable));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(0.75).sub(fee), 0.03);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(1.05).add(fee)); // small number almost ~ 0
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(redeemable, 0.05);  // ~ 0.96
      });

      it("Issue then verify redeem of 0.85 Z ( > ltv) after leveraging", async function() {
        let quantity = ether(1);
        let redeemable = ether(0.85);  //   
        let fee  =  ether(0.05);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(quantity.sub(redeemable));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity.sub(redeemable));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(0.85).add(ether(0.8)).sub(fee), 0.03);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.15).add(fee)); // small number almost ~ 0
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(redeemable, 0.05);  // 
      });

      it("Issue then verify redeem of 1 Z (all Z balance) after leveraging", async function() {
        // redeem all 
        // this required internal delever

        let quantity = ether(1);
        let redeemable = ether(1);  //   
        let fee  =  ether(0.05);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );
        await aWethTracker.push(zToken.address);
        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(0.8), 0.03);
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity);

        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(1.8).sub(fee));
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(fee); // small number almost ~ 0
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(quantity, 0.05);  // ~ 0.96
      });

      it("Issue then verify redeem of 1 Z (all Z balance) after double leveraging", async function() {
        let quantity = ether(1);
        let redeemable = ether(1);  //   
        let fee  =  ether(0.05);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(620),
          ether(0.58),
          "UNISWAP",
          "0x"
        );
        await aWethTracker.push(zToken.address);
        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(1.38), 0.03);  // 0.58 + 0.8
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity);

        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(2.3));
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.07)); // need relook (i.e. should be smaller)
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(ether(0.95), 0.05);  // need relook (a lot of loss) 
      });


      it.skip("Issue then verify redeem of 1 Z after leveraging", async function() {
        // FIXME: TODO: TODO: use delever in order to redeem all
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

    describe("Multiple Users issue and redeem", async function() {
      it.only("Issue then verify redeem of all Z balance after leveraging", async function() {
        let quantityA = ether(2);
        let redeemableA = ether(2);  //   
        let quantityB = ether(1);  //   
        let redeemableB = ether(1);  //   
        let fee  =  ether(0.05);  // this is approx swap fee;
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantityB);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantityA);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantityA, alice.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantityB, bob.address);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantityB.add(quantityA));
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          "UNISWAP",
          "0x"
        );

        await aWethTracker.push(zToken.address);
        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(0.75*3), 0.03);  //  0.8
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantityB);
        expect(await zToken.balanceOf(alice.address)).to.be.eq(quantityA);

        await wethTracker.pushMultiple([bob.address, alice.address]);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemableA, alice.address);
        // FIXME: cannot redeem for Bob because "revert reason string 15" , error from aave pool
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemableB, bob.address);
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address]);
        
        // expect(await zToken.totalSupply()).to.be.eq(ether(0));
        // expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await zToken.balanceOf(alice.address)).to.be.eq(ether(0));
        // expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(1.75));
        // expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.07)); // need relook (i.e. should be smaller)
        // expect(wethTracker.lastEarned(bob.address)).to.be.approx(ether(0.95), 0.05);  // need relook (a lot of loss) 
      });


    });
 
});