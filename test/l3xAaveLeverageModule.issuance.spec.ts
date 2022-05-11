
import "../utils/test/types";
import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { createFixtureLoader, solidity } from "ethereum-waffle";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2LendingPool} from "@setprotocol/set-protocol-v2/typechain/AaveV2LendingPool";
import {AaveV2AToken} from "@setprotocol/set-protocol-v2/dist/utils/contracts/aaveV2";

import {ether, approx, preciseMul, bitcoin} from "../utils/helpers";
import {usdc as usdcUnit} from "../utils/common/unitsUtils";

import { Context } from "../utils/test/context";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_INT_256, MAX_UINT_256, ZERO } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "../utils/test/BalanceTracker";

import {initUniswapRouter} from "../utils/test/context";
import { WETH9 } from "@typechain/WETH9";
import { SetToken } from "@typechain/SetToken";
chai.use(solidity);
chai.use(approx);

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
      let UNISWAP_INTEGRATION = "UNISWAP";

      beforeEach("", async function(){
        ctx = new Context();
        await ctx.initialize(false);  // 
        bob = ctx.accounts.bob;
        owner = ctx.accounts.owner;
        alice = ctx.accounts.alice;
        weth = ctx.tokens.weth as WETH9;
        dai = ctx.tokens.dai;
        daiTracker = new BalanceTracker(dai);

        aaveLender = ctx.aaveFixture.lendingPool;
        zToken = ctx.sets[0];
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

      it.skip("Sync -- verify sync produces the proper positionUnit", async function() {
        let quantity = ether(1);
        let positionUnit = ether(1);
        await weth.connect(bob.wallet).approve(aaveLender.address, quantity);
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aaveLender.connect(bob.wallet).deposit(weth.address, quantity, bob.address, 0);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);

        expect(await zToken.getDefaultPositionRealUnit(ctx.aTokens.aWeth.address)).to.be.eq(positionUnit);

        await ctx.ct.aaveLeverageModule.sync(zToken.address);
        expect(await zToken.getDefaultPositionRealUnit(ctx.aTokens.aWeth.address)).to.be.eq(positionUnit);
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          UNISWAP_INTEGRATION,
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


      it("Issue then verify redeem of 0.75 Z ( < ltv) after leveraging", async function() {
        let quantity = ether(0.01);
        let redeemable = ether(0.0075);  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          UNISWAP_INTEGRATION,
          "0x"
        );
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address, ZERO);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(quantity.sub(redeemable));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity.sub(redeemable));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(0.008).sub(fee), 0.03);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.approx(ether(0.01).add(fee), 0.03); // 
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(redeemable, 0.05);  // ~ 0.96
      });

      it("Issue then verify redeem of 0.85 Z ( > ltv) after leveraging", async function() {
        let quantity = ether(1);
        let redeemable = ether(0.85);  //   
        let fee  =  ether(0.05);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          UNISWAP_INTEGRATION,
          "0x"
        );
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address, ZERO);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(quantity.sub(redeemable));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity.sub(redeemable));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(0.85).add(ether(0.8)).sub(fee), 0.03);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.15).add(fee)); // small number almost ~ 0
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(redeemable, 0.05);  // 
      });

      it("Issue then verify redeem of .01 Z (all Z balance) after leveraging", async function() {
        // redeem all 
        // this required internal delever

        let quantity = ether(0.01);
        let redeemable = ether(0.01);  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          UNISWAP_INTEGRATION,
          "0x"
        );
        await aWethTracker.push(zToken.address);
        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(0.008), 0.03);
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity);

        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address, ZERO);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(0.018));
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.000001)); // small number almost ~ 0
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(quantity );  // ~ 0.96
      });

      it("Issue then verify redeem of .01 Z (all Z balance) after double leveraging", async function() {
        let quantity = ether(0.01);
        let redeemable = ether(0.01);  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await ctx.aTokens.aWeth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantity);
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          UNISWAP_INTEGRATION,
          "0x"
        );
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(620),
          ether(0.6),
          UNISWAP_INTEGRATION,
          "0x"
        );
        await aWethTracker.push(zToken.address);
        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(0.0144), 0.03);  // 
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantity);

        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemable, bob.address, ZERO);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(0.024));
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.0005)); // need relook (i.e. should be smaller)
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(ether(0.0095), 0.05);  // need relook (a lot of loss) 
      });


      it("Issue then verify redeem of 1 Z after leveraging", async function() {
        let quantity = ether(1);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          UNISWAP_INTEGRATION,
          "0x"
        );
        await aWethTracker.push(zToken.address);

        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, quantity, bob.address, ZERO);
        await wethTracker.push(bob.address);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(preciseMul(quantity, ether(1.8)));
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(quantity);
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.000001));

      });
        // resolveDebtPositions by implementing new issuanceModule 
        // - callModulePreredeemHook changes virtualUnit - equityUnits = units-debt , debtUnits=0 - resolve

    });

    describe("Multiple Users issue and redeem", async function() {
      it("Issue then verify redeem of all Z balance after leveraging", async function() {
        let quantityA = ether(0.02);
        let redeemableA = ether(0.02);  //   
        let quantityB = ether(0.01);  //   
        let redeemableB = ether(0.01);  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantityB);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantityA);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantityA, alice.address, MAX_UINT_256);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantityB, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        expect(aWethTracker.lastEarned(zToken.address)).to.be.eq(quantityB.add(quantityA));
        
        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(800),
          ether(0.75),
          UNISWAP_INTEGRATION,
          "0x"
        );

        await aWethTracker.push(zToken.address);
        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(0.008*3), 0.03);  //  0.8
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantityB);
        expect(await zToken.balanceOf(alice.address)).to.be.eq(quantityA);

        await wethTracker.pushMultiple([bob.address, alice.address]);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemableA, alice.address, ZERO);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemableB, bob.address, ZERO);
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address]);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await zToken.balanceOf(alice.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(0.018*3));

        // There is a 2% discrepancy
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.00001)); //  ~ 0.00060655 
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(quantityB);  // ~ 0.0097498   
        expect(wethTracker.lastEarned(alice.address)).to.be.approx(quantityA);   
      });
      it("Issue then verify redeem of all Z balance after leveraging", async function() {
        let quantities = [ether(0.02), ether(0.01), ether(0.01)];
        let redeemables = [ether(0.02), ether(0.01), ether(0.01)];  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantities[0]);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantities[1]);
        await weth.approve(ctx.ct.issuanceModule.address, quantities[2]);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantities[0], alice.address, MAX_UINT_256);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address, MAX_UINT_256);
        await ctx.ct.issuanceModule.issue(zToken.address, quantities[2], owner.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);

        let leverParams = [
          {q: ether(800), b: ether(0.75)},
          {q: ether(620), b: ether(0.6)},
          {q: ether(500), b: ether(0.45)},
          {q: ether(320), b: ether(0.3)}
        ];

        let totalLev = ether(3.24);   // summation of q element + 1 in leverParams
        
        for(let param of leverParams) {
          await ctx.ct.aaveLeverageModule.lever(
            zToken.address,
            dai.address,
            weth.address,
            param.q,
            param.b,
            UNISWAP_INTEGRATION,
            "0x"
          );
        } 

        await aWethTracker.push(zToken.address);
        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(2.24*0.01*4), 0.03);  //  0.8
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantities[1]);
        expect(await zToken.balanceOf(alice.address)).to.be.eq(quantities[0]);

        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemables[0], alice.address, ZERO);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address, ZERO);

        // this took 16 loops in for-loop to delever
        await ctx.ct.issuanceModule.connect(owner.wallet).redeem(zToken.address, redeemables[2], owner.address, ZERO);
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await zToken.balanceOf(alice.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(3.24*0.01*4));

        // // There is a 2.5% discrepancy because of 3x lev // might do a hack on redeem in code
        // hack: give 0.7% redeem bonus for 1x lev -> redeem = redeem * (1  + 0.007 * leverage)
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.00001)); //  ~ 0.00000
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(quantities[1]);  // ~ 0.00986557466   
        expect(wethTracker.lastEarned(alice.address)).to.be.approx(quantities[0] );  // ~ 0.01973123 
      });
    });

    describe("Verify validity of IssuingFactor ", async function () {
      it("Verify issuing factor is around & gt one after delever to lev1x and price rise", async function (){
        // issueA -> lever -> delever -> price ^ -> issueA
        let quantity1 = ether(0.02);
        let quantity2 = ether(0.005);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 

        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity1, alice.address, MAX_UINT_256);
        
        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);

        let params = [
          {q: ether(800), b: ether(0.75)},
          {q: ether(785), b: ether(0.795)},
        ];

          await ctx.ct.aaveLeverageModule.lever(
            zToken.address,
            dai.address,
            weth.address,
            params[0].q,
            params[0].b,
            UNISWAP_INTEGRATION,
            "0x"
          );

          await ctx.ct.aaveLeverageModule.delever(
            zToken.address,
            weth.address,
            dai.address,
            params[1].b,
            params[1].q,
            UNISWAP_INTEGRATION,
            "0x"
          );
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0008));  // 1 ETH = 1250 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(1250), ether(1000));

        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity2, alice.address, MAX_UINT_256);
        await wethTracker.push(alice.address);
        let issueCost = wethTracker.lastSpent(alice.address);

        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, quantity2.add(quantity1), alice.address, ZERO);
        await wethTracker.push(alice.address);

        let wethRedeemed = wethTracker.lastEarned(alice.address);   // 
        let expectedWethRedeemed = quantity1.add(quantity2);  // 0.025 eth

        // IssuingFactor ~ 1 because leverage is 1x / it also is expected to be greater than 1
        expect(issueCost).to.be.approx(quantity2);
        expect(issueCost).to.be.gt(quantity2);
        expect(wethRedeemed).to.be.approx(expectedWethRedeemed);
      });

      it("Verify issuing factor is as expected after delever price rise", async function (){
        // issueA -> lever -> delever -> price ^ -> issueA
        let quantity1 = ether(0.02);
        let quantity2 = ether(0.005);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 

        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity1, alice.address, MAX_UINT_256);
        
        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);

        let params = [
          {q: ether(800), b: ether(0.75)},
          {q: ether(350), b: ether(0.4)},
        ];

          await ctx.ct.aaveLeverageModule.lever(
            zToken.address,
            dai.address,
            weth.address,
            params[0].q,
            params[0].b,
            UNISWAP_INTEGRATION,
            "0x"
          );

          await ctx.ct.aaveLeverageModule.delever(
            zToken.address,
            weth.address,
            dai.address,
            params[1].b,
            params[1].q,
            UNISWAP_INTEGRATION,
            "0x"
          );
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0008));  // 1 ETH = 1250 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(1250), ether(1000));

        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity2, alice.address, MAX_UINT_256);
        await wethTracker.push(alice.address);
        let issueCost = wethTracker.lastSpent(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, quantity2.add(quantity1), alice.address, ZERO);
        await wethTracker.push(alice.address);

        let wethRedeemed = wethTracker.lastEarned(alice.address);   // 26932481526926299;

        let expectedIssueCost = preciseMul(quantity2, ether(1.08));
        // (leverage-1)*price_rise/price*quantity
        let profit = ether(0.4*250/1250*0.02);
        let expectedWethRedeemed = quantity1.add(profit).add(expectedIssueCost);  // 0.027 eth

        // IssuingFactor ~ 1.08 , leverage is 1.4x 
        expect(issueCost).to.be.approx(expectedIssueCost);
        expect(wethRedeemed).to.be.approx(expectedWethRedeemed);
        expect(await ctx.aTokens.aWeth.balanceOf(zToken.address)).to.be.lt(ether(0.00001));
      });

      it("Verify issuing factor is as expected after lever price rise", async function (){
        // issueA -> lever -> price ^ -> issueA
        let quantity1 = ether(0.02);
        let quantity2 = ether(0.005);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 

        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity1, alice.address, MAX_UINT_256);
        
        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);

        let params = [
          {q: ether(500), b: ether(0.45)},
        ];

          await ctx.ct.aaveLeverageModule.lever(
            zToken.address,
            dai.address,
            weth.address,
            params[0].q,
            params[0].b,
            UNISWAP_INTEGRATION,
            "0x"
          );

        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0008));  // 1 ETH = 1250 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(1250), ether(1000));

        await aWethTracker.push(zToken.address);
        await wethTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity2, alice.address, MAX_UINT_256);
        await wethTracker.push(alice.address);
        let issueCost = wethTracker.lastSpent(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, quantity2.add(quantity1), alice.address, ZERO);
        await wethTracker.push(alice.address);

        let wethRedeemed = wethTracker.lastEarned(alice.address);   // ;

        let expectedIssueCost = preciseMul(quantity2, ether(1.1));
        // (leverage-1)*price_rise/price*quantity
        let profit = ether(0.5*250/1250*0.02);
        let expectedWethRedeemed = quantity1.add(profit).add(expectedIssueCost);  // 0.0275 eth

        // IssuingFactor ~ 1.1 , leverage is 1.5x 
        expect(issueCost).to.be.approx(expectedIssueCost);
        expect(wethRedeemed).to.be.approx(expectedWethRedeemed);
        expect(await ctx.aTokens.aWeth.balanceOf(zToken.address)).to.be.lt(ether(0.00001));
      });
    });

    describe("Issue/Redeem for other token bases", async function() {
      let btcIndex: SetToken;
      let btc: StandardTokenMock;
      let aBtc: any;
      let btcTracker: BalanceTracker ;
      let aBtcTracker: BalanceTracker;
      beforeEach ("",  async function(){
        await ctx.createLevBtcIndex();
        btcIndex = ctx.sets[ctx.sets.length-1];
        btc = ctx.tokens.btc;
        aBtc = ctx.aTokens.aBtc;
        btcTracker = new BalanceTracker(btc);
        aBtcTracker = new BalanceTracker(aBtc);
        
        await btc.transfer(alice.address, bitcoin(10));
      }) ;
      it("Issuing levBtc -- lev3x token with btc base", async function () {
        let quantity = ether(0.2);  // 
        let expectedEquityAmount = bitcoin(0.2);
        await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(btcIndex.address, quantity, alice.address, MAX_UINT_256);
        
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);

        expect(btcTracker.lastSpent(alice.address)).to.be.eq(expectedEquityAmount);
        expect(aBtcTracker.lastEarned(btcIndex.address)).to.be.eq(expectedEquityAmount);
      });

      it("Redeemig levBtc 1x lev -- lev3x token with btc base", async function () {
        let quantity = ether(0.1);  // 
        let expectedEquityAmount = bitcoin(0.1);
        await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(btcIndex.address, quantity, alice.address, MAX_UINT_256);

        // That leverage is effectively nil but added as an edge case and to update components
        await ctx.ct.aaveLeverageModule.lever(
          btcIndex.address,
          dai.address,
          btc.address,
          ether(0.1),
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(btcIndex.address, quantity, alice.address, ZERO);
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);

        expect(btcTracker.lastEarned(alice.address)).to.be.approx(expectedEquityAmount);
        expect(aBtcTracker.lastSpent(btcIndex.address)).to.be.approx(expectedEquityAmount);
      });

      it("Redeemig levBtc -- lev3x token with btc base", async function () {
        let quantity = ether(0.1);  // 
        let expectedEquityAmount = bitcoin(0.1);
        await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(btcIndex.address, quantity, alice.address, MAX_UINT_256);

        await ctx.ct.aaveLeverageModule.lever(
          btcIndex.address,
          dai.address,
          btc.address,
          ether(8000),
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(btcIndex.address, quantity, alice.address, ZERO);
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);

        expect(btcTracker.lastEarned(alice.address)).to.be.approx(expectedEquityAmount);
        expect(aBtcTracker.lastSpent(btcIndex.address)).to.be.approx(bitcoin(0.18));
      });

      it("Redeemig levBtc after a delever -- lev3x token with btc base", async function () {
        let quantity = ether(0.1);  // 
        let expectedEquityAmount = bitcoin(0.1);
        await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(btcIndex.address, quantity, alice.address, MAX_UINT_256);

        await ctx.ct.aaveLeverageModule.lever(
          btcIndex.address,
          dai.address,
          btc.address,
          ether(8000),
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        await ctx.ct.aaveLeverageModule.delever(
          btcIndex.address,
          btc.address,
          dai.address,
          bitcoin(0.78),
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(btcIndex.address, quantity, alice.address, ZERO);
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);

        expect(btcTracker.lastEarned(alice.address)).to.be.approx(expectedEquityAmount);
        expect(aBtcTracker.lastSpent(btcIndex.address)).to.be.approx(expectedEquityAmount);
      });



    });

    describe("Issue/Redeem for other token quotes", async function() {
      let btcIndex: SetToken;  // usdc base
      let btc: StandardTokenMock;
      let aBtc: any;
      let btcTracker: BalanceTracker ;
      let aBtcTracker: BalanceTracker;
      let usdc: StandardTokenMock;
      beforeEach ("",  async function(){
        await ctx.createLevBtcIndex(ctx.tokens.usdc);
        btcIndex = ctx.sets[ctx.sets.length-1];
        btc = ctx.tokens.btc;
        usdc = ctx.tokens.usdc;
        aBtc = ctx.aTokens.aBtc;
        btcTracker = new BalanceTracker(btc);
        aBtcTracker = new BalanceTracker(aBtc);


        await ctx.tokens.usdc.approve(ctx.aaveFixture.lendingPool.address, MAX_UINT_256);

        await ctx.aaveFixture.lendingPool.deposit(
          ctx.tokens.usdc.address,
          usdcUnit(1000),
          ctx.accounts.owner.address,
          ZERO
        );
        
        await btc.transfer(alice.address, bitcoin(10));
      }) ;
 

      it("Redeemig levBtc after a delever against usdc -- usdc as borrow asset ", async function () {
        let quantity = ether(0.1);  // 
        let expectedEquityAmount = bitcoin(0.1);
        await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(btcIndex.address, quantity, alice.address, MAX_UINT_256);

        await ctx.ct.aaveLeverageModule.lever(
          btcIndex.address,
          usdc.address,
          btc.address,
          usdcUnit(8000),
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        await ctx.ct.aaveLeverageModule.delever(
          btcIndex.address,
          btc.address,
          usdc.address,
          bitcoin(0.78),
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(btcIndex.address, quantity, alice.address, ZERO);
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);

        expect(btcTracker.lastEarned(alice.address)).to.be.approx(expectedEquityAmount);
        expect(aBtcTracker.lastSpent(btcIndex.address)).to.be.approx(expectedEquityAmount);
      });

      it("Redeemig levBtc -- lev3x token with btc base", async function () {
        let quantity = ether(0.1);  // 
        let expectedEquityAmount = bitcoin(0.1);
        await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(btcIndex.address, quantity, alice.address, MAX_UINT_256);

        await ctx.ct.aaveLeverageModule.lever(
          btcIndex.address,
          usdc.address,
          btc.address,
          usdcUnit(8000),
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(btcIndex.address, quantity, alice.address, ZERO);
        await aBtcTracker.push(btcIndex.address);
        await btcTracker.push(alice.address);

        expect(btcTracker.lastEarned(alice.address)).to.be.approx(expectedEquityAmount);
        expect(aBtcTracker.lastSpent(btcIndex.address)).to.be.approx(bitcoin(0.18));
      });
    });
    describe("Issue/Redeem for bear token ", async function() {
      let bearIndex: SetToken;  // usdc base
      let btc: StandardTokenMock;
      let aBtc: any;
      let usdcTracker: BalanceTracker ;
      let aUsdcTracker: BalanceTracker;
      let usdc: StandardTokenMock;
      let aUsdc: any;
      beforeEach ("",  async function(){
        await ctx.createBearIndex(ctx.tokens.btc);
        bearIndex = ctx.sets[ctx.sets.length-1];
        btc = ctx.tokens.btc;
        usdc = ctx.tokens.usdc;
        aUsdc = ctx.aTokens.aUsdc;
        usdcTracker = new BalanceTracker(usdc);
        aUsdcTracker = new BalanceTracker(aUsdc);

        await ctx.tokens.btc.approve(ctx.aaveFixture.lendingPool.address, MAX_UINT_256);

        await ctx.aaveFixture.lendingPool.deposit(
          ctx.tokens.btc.address,
          bitcoin(20),
          ctx.accounts.owner.address,
          ZERO
        );
        
        await usdc.transfer(alice.address, usdcUnit(10000));
      }) ;
      
      it("Issue bearBtc -- lev3x token with usdc as collateral and btc as borrow", async function () {
        let quantity = ether(1000);  // 
        let expectedEquityAmount = usdcUnit(1000);
        await usdc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(bearIndex.address, quantity, alice.address, MAX_UINT_256);

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);

        expect(aUsdcTracker.lastEarned(bearIndex.address)).to.be.eq(expectedEquityAmount);
        expect(usdcTracker.lastSpent(alice.address)).to.be.eq(expectedEquityAmount);
      });

      it("Issue bearBtc -- lev3x token with btc base", async function () {
        let quantity = ether(1000);  // 
        let expectedEquityAmount = usdcUnit(1000);
        await usdc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, quantity);  // ∵ 

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(bearIndex.address, quantity, alice.address, MAX_UINT_256);

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);

        await ctx.ct.aaveLeverageModule.lever(
          bearIndex.address,
          btc.address,
          usdc.address,
          bitcoin(0.8).div(10000),  // borrow 0.00008 btc for each 1 usdc
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );
        
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(bearIndex.address, quantity, alice.address, ZERO);
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);

        expect(usdcTracker.lastEarned(alice.address)).to.be.approx(expectedEquityAmount);
        expect(aUsdcTracker.lastSpent(bearIndex.address)).to.be.approx(usdcUnit(1800));
      });
    });
});