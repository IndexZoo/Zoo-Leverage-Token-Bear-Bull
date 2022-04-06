
import "../utils/test/types";
import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { createFixtureLoader, solidity } from "ethereum-waffle";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2LendingPool} from "@setprotocol/set-protocol-v2/typechain/AaveV2LendingPool";

import {ether, approx, preciseMul, preciseDiv} from "../utils/helpers";

import { Context } from "../utils/test/context";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_INT_256, MAX_UINT_256, ZERO } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "../utils/test/BalanceTracker";

import {initUniswapRouter} from "../utils/test/context";
import { WETH9 } from "@typechain/WETH9";
import { BigNumber, Contract, ContractTransaction, Wallet } from "ethers";
import { UniswapV2Router02 } from "@setprotocol/set-protocol-v2/typechain/UniswapV2Router02";
import { SetToken } from "@typechain/SetToken";
import {usdc as usdcUnit, bitcoin} from "../utils/common/unitsUtils";
import { UniswapV2Router02Mock } from "@typechain/UniswapV2Router02Mock";
chai.use(solidity);
chai.use(approx);

const advanceTime = async (duration: number): Promise<void> => {
  await ethers.provider.send('evm_increaseTime', [duration*3600*24*365.25]); // duration in years 
};

describe("Complex scenarios with Aaveleverage", function () {
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
    describe("Issue and redeem with price change ", async function(){
      it("Issue then verify redeem of all Z balance after leveraging for Bob and price rise", async function() {
        let quantities = [ether(0.02), ether(0.01), ether(0.01)];
        let redeemables = [ether(0.02), ether(0.01), ether(0.01)];  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantities[1].mul(4));

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address, MAX_UINT_256);
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
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0008));  // 1 ETH = 1250 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(1250), ether(1000));

        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(2.24*0.01), 0.03);  //  0.8
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantities[1]);

        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address, ZERO);

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);

        let expectedBobRedeem = ether(2.24).mul(250).div(100).div(1250).add(quantities[1]);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(3.24*0.01));

        // // There is a 3% discrepancy because of 3x lev and winning // might do a hack on redeem in code
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.00001)); //  ~ 0.00050009
        // finalWeth*finalPrice - initWeth*initPrice = priceRise * leverage * initWeth
        //     => 0.0144*1250 - 0.01*1000 ~ 250 * 3.24 * 0.01
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(expectedBobRedeem);  // ~ 0.01390784  
      });

      it("Issue then verify redeem of all Z balance after leveraging for 3 users and price rise", async function() {
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
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0008));  // 1 ETH = 1250 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(1250), ether(1000));
        let expectedBobRedeem = ether(2.24).mul(250).div(100).div(1250).add(quantities[1]);

        
        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(2.24*0.01*4), 0.03);  //  0.8
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantities[1]);

        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemables[0], alice.address, ZERO);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address, ZERO);
        await ctx.ct.issuanceModule.connect(owner.wallet).redeem(zToken.address, redeemables[2], owner.address, ZERO);
        
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await zToken.balanceOf(alice.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(3.24*0.01*4));

        // // There is a 0.2% discrepancy because of 3x lev and winning // might do a hack on redeem in code
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.0001)); //  ~ 0.000082118
        // finalWeth*finalPrice - initWeth*initPrice = priceRise * leverage * initWeth
        //     Bob => 0.0144*1250 - 0.01*1000 ~ 250 * 3.24 * 0.01
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(expectedBobRedeem);  // ~ 0.01390784  
        // alice is expected to earn double as much as bob
        expect(wethTracker.lastEarned(alice.address)).to.be.approx(expectedBobRedeem.mul(2));   
      });

      it("Issue then verify redeem of all Z balance after leveraging for Bob only and price fall", async function() {
        let quantities = [ether(0.02), ether(0.01), ether(0.01)];
        let redeemables = [ether(0.02), ether(0.01), ether(0.01)];  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantities[1]);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address, MAX_UINT_256);
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
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.001125));  // 1 ETH = 888.889 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(888.89), ether(1000));

        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(ether(2.24*0.01), 0.03);  //  0.8
        expect(await zToken.balanceOf(bob.address)).to.be.eq(quantities[1]);

        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address, ZERO);

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        let expectedBobRedeem = quantities[1].sub( ether(2.24).mul(112).div(100).div(890) );
        
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(ether(3.24*0.01));

        // // There is a 5% residue because of 3x lev and price dev // might do a hack on redeem in code
        expect(aWethTracker.totalEarned(zToken.address)).to.be.lt(ether(0.00055)); //  ~ 0.0000
        // finalWeth*finalPrice - initWeth*initPrice = priceRise * leverage * initWeth
        //     => 0.0144*1250 - 0.01*1000 ~ 250 * 3.24 * 0.01
        expect(wethTracker.lastEarned(bob.address)).to.be.approx(expectedBobRedeem, 0.04 );  // ~ 0.007033
      });

      it("Scenario users issue and redeem after and before leveraging with price change ", async function() {
        // issue1 -> leverage -> issue2 -> redeem1 -> redeem2
        let quantities = [ether(0.02), ether(0.01), ether(0.01)];
        let redeemables = [ether(0.02), ether(0.01), ether(0.01)];  //   
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address, MAX_UINT_256);
        
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        let bobIssue = wethTracker.lastSpent(bob.address);

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
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0008));  // 1 ETH = 1250 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(1250), ether(1000));

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantities[0], alice.address, MAX_UINT_256);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address, ZERO);

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        let bobRedeem = wethTracker.lastEarned(bob.address);
        let aliceIssue = wethTracker.lastSpent(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemables[0], alice.address, ZERO);
        
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await aWethTracker.push(zToken.address);
        
        let aliceRedeem = (wethTracker.lastEarned(alice.address));

        // profit in base = (3.24-1)*250*0.01/1250 = (lev-1)*price_jump*quantity/new_price
        let expectedBobRedeem = (totalLev.sub(ether(1)).mul(250).div(1250*100)).add(bobIssue); 
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await zToken.balanceOf(alice.address)).to.be.eq(ether(0));

        // // There is a 3% discrepancy because of 3x lev and winning // might do a hack on redeem in code
        expect(await ctx.aTokens.aWeth.balanceOf(zToken.address)).to.be.lt(ether(0.00001)); //  ~ 0.00000622767
        expect(bobRedeem).to.be.approx(expectedBobRedeem);
        expect(aliceIssue).to.be.approx(aliceRedeem);
      });

      it("Scenario users issue and redeem after and before leveraging with price change ", async function() {
        // issue1 -> leverage -> redeem1 -> issue2 -> redeem2
        let quantities = [ether(0.02), ether(0.01), ether(0.01)];
        let redeemables = [ether(0.02), ether(0.01), ether(0.01)];  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantities[1]);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address, MAX_UINT_256);
        
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        let bobIssue = wethTracker.lastSpent(bob.address);

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
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0008));  // 1 ETH = 1250 dai
        await ctx.changeUniswapPrice(owner, weth, dai, ether(1250), ether(1000));

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address, ZERO);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantities[0], alice.address, MAX_UINT_256);

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        let bobRedeem = wethTracker.lastEarned(bob.address);
        let aliceIssue = wethTracker.lastSpent(alice.address);        

        // Alice is receiving the residue of the LevToken because debt=0 hence swapFactor does not kick in
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemables[0], alice.address, ZERO);
        
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await aWethTracker.push(zToken.address);
        
        let aliceRedeem = (wethTracker.lastEarned(alice.address));
        let expectedBobProfit =   preciseMul(totalLev, ether(250)).mul(quantities[1]).div(ether(1000));
        expect(await zToken.totalSupply()).to.be.eq(ether(0));
        expect(await zToken.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await zToken.balanceOf(alice.address)).to.be.eq(ether(0));

        expect(await ctx.aTokens.aWeth.balanceOf(zToken.address)).to.be.eq(ether(0)); //  
        expect(aliceIssue).to.be.approx(aliceRedeem);
        // bobRedeem - bobIssue ~ 250*0.01*(3.24-1)/1250
        expect(bobRedeem.mul(1250).div(1000).sub( bobIssue)).to.be.approx(expectedBobProfit);
      });

    });

    describe("Bear tokens", async function () {
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
        await ctx.tokens.btc.approve(ctx.router!.address, MAX_UINT_256);
        await ctx.tokens.usdc.approve(ctx.router!.address, MAX_UINT_256);

        await ctx.aaveFixture.lendingPool.deposit(
          ctx.tokens.btc.address,
          bitcoin(20),
          ctx.accounts.owner.address,
          ZERO
        );
        
        await usdc.transfer(alice.address, usdcUnit(10000));
        await usdc.transfer(bob.address, usdcUnit(10000));
      }) ;
      it("1 user issue/redeem Price dip > profit", async function () {
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

        await ctx.aaveFixture.setAssetPriceInOracle(usdc.address, ether(0.001125));  // 0.1 BTC = 1 ETH = 0.001125 usdc 
        await ctx.changeUniswapPrice(
          owner, 
          btc, 
          usdc, 
          usdcUnit(8889), 
          usdcUnit(10000),
          bitcoin(40),
          usdcUnit(400000),
          bitcoin 
        );

        // verify uniswap pricing is as expected 
        let usdcAmountOut = (await ctx.router.getAmountsOut(bitcoin(1), [btc.address, usdc.address]))[1];
        expect(usdcAmountOut).to.be.approx(usdcUnit(8889));
        
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(bearIndex.address, quantity, alice.address, ZERO);
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.push(alice.address);
 
        // 0.0000125 * 1000 * 0.8 / 0.0001125
        let expectedAliceProfit = usdcUnit(88);

        expect(usdcTracker.lastEarned(alice.address))
            .to.be.approx(expectedEquityAmount.add(expectedAliceProfit));
        expect(aUsdcTracker.lastSpent(bearIndex.address)).to.be.approx(usdcUnit(1800));
      });

      it("Scenario users issue and redeem after and before leveraging with price change ", async function() {
        // issue1 -> leverage -> issue2 -> redeem1 -> redeem2
        let quantities = [ether(2000), ether(1000), ether(1000)];
        let redeemables = [usdcUnit(2000), usdcUnit(1000), usdcUnit(1000)];  //   
        await usdc.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);
        await usdc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(bearIndex.address, quantities[1], bob.address, MAX_UINT_256);
        
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        let bobIssue = usdcTracker.lastSpent(bob.address);

        let leverParams = [
          {q: bitcoin(0.8).div(10000), b: usdcUnit(7500).div(10000)},
          {q: bitcoin(0.620).div(10000), b: usdcUnit(600).div(10000)},
          {q: bitcoin(0.500).div(10000), b: usdcUnit(4500).div(10000)},
          {q: bitcoin(0.320).div(10000), b: usdcUnit(3000).div(10000)}
        ];

        let totalLev = ether(3.24);   // summation of q element + 1 in leverParams
        
        for(let param of leverParams) {
          await ctx.ct.aaveLeverageModule.lever(
            bearIndex.address,
            btc.address,
            usdc.address,
            param.q,
            ZERO,
            UNISWAP_INTEGRATION,
            "0x"
          );
        } 
        await ctx.aaveFixture.setAssetPriceInOracle(usdc.address, ether(0.001125));  // 1 ETH = 1250 usdc 
        await ctx.changeUniswapPrice(
          owner, 
          btc, 
          usdc, 
          usdcUnit(8889), 
          usdcUnit(10000),
          bitcoin(40),
          usdcUnit(400000),
          bitcoin 
        );
        // verify uniswap pricing is as expected 
        let usdcAmountOut = (await ctx.router.getAmountsOut(bitcoin(1), [btc.address, usdc.address]))[1];
        expect(usdcAmountOut).to.be.approx(usdcUnit(8889));

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(bearIndex.address, quantities[0], alice.address, MAX_UINT_256);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(bearIndex.address, quantities[1], bob.address, ZERO);
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        let bobRedeem = usdcTracker.lastEarned(bob.address);
        let aliceIssue = usdcTracker.lastSpent(alice.address);
          
          // bob redeeming required total deleveraging, hence we do a trivial lever here in order to redeem for alice
          await ctx.ct.aaveLeverageModule.lever(
            bearIndex.address,
            btc.address,
            usdc.address,
            1,
            ZERO,
            UNISWAP_INTEGRATION,
            "0x"
          );

        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(bearIndex.address, quantities[0], alice.address, ZERO);
        
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await aUsdcTracker.push(bearIndex.address);
        
        let aliceRedeem = (usdcTracker.lastEarned(alice.address));

        // 0.0000125 * 1000 * 2.24 / 0.0001125
        let expectedBobProfit = usdcUnit(248);

        expect(await bearIndex.totalSupply()).to.be.eq(ether(0));
        expect(await bearIndex.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await bearIndex.balanceOf(alice.address)).to.be.eq(ether(0));

        expect(await ctx.aTokens.aUsdc.balanceOf(bearIndex.address)).to.be.lt(BigNumber.from(1000)); //  ~ 0.00000622767
        expect(bobRedeem).to.be.approx(expectedBobProfit.add(redeemables[1]));
        expect(aliceIssue).to.be.approx(aliceRedeem);  // 1.3% less redeem due to fees
      });
    });
    describe("Stream fees scenarios", async function () {
      let bearIndex: SetToken;  // usdc base
      let btc: StandardTokenMock;
      let protocolFeeRecipient: Account;
      let aBtc: any;
      let usdcTracker: BalanceTracker ;
      let aUsdcTracker: BalanceTracker;
      let usdc: StandardTokenMock;
      let aUsdc: any;
      beforeEach ("",  async function(){
        await ctx.createBearIndex(ctx.tokens.btc);
        protocolFeeRecipient = ctx.accounts.protocolFeeRecipient;
        bearIndex = ctx.sets[ctx.sets.length-1];
        btc = ctx.tokens.btc;
        usdc = ctx.tokens.usdc;
        aUsdc = ctx.aTokens.aUsdc;
        usdcTracker = new BalanceTracker(usdc);
        aUsdcTracker = new BalanceTracker(aUsdc);

        await ctx.tokens.btc.approve(ctx.aaveFixture.lendingPool.address, MAX_UINT_256);
        await ctx.tokens.btc.approve(ctx.router!.address, MAX_UINT_256);
        await ctx.tokens.usdc.approve(ctx.router!.address, MAX_UINT_256);

        await ctx.aaveFixture.lendingPool.deposit(
          ctx.tokens.btc.address,
          bitcoin(20),
          ctx.accounts.owner.address,
          ZERO
        );
        
        await usdc.transfer(alice.address, usdcUnit(10000));
        await usdc.transfer(bob.address, usdcUnit(10000));

          // await ctx.ct.aaveLeverageModule.lever(
          //   bearIndex.address,
          //   btc.address,
          //   usdc.address,
          //   1,
          //   ZERO,
          //   UNISWAP_INTEGRATION,
          //   "0x"
          // );
      }) ;

      it("Scenario users issue and redeem after and before leveraging with price change ", async function() {
        // issue1 -> leverage -> advanceTime: accrueFee -> issue2 -> redeem1 -> redeem2
        let quantities = [ether(2000), ether(1000), ether(1000)];
        let redeemables = [usdcUnit(2000), usdcUnit(1000), usdcUnit(1000)];  //   
        let years = 2;
        await usdc.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);
        await usdc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(bearIndex.address, quantities[1], bob.address, MAX_UINT_256);
        
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        let bobIssue = usdcTracker.lastSpent(bob.address);

        let leverParams = [
          {q: bitcoin(0.8).div(10000), b: usdcUnit(7500).div(10000)},
          {q: bitcoin(0.620).div(10000), b: usdcUnit(600).div(10000)},
          {q: bitcoin(0.500).div(10000), b: usdcUnit(4500).div(10000)},
          {q: bitcoin(0.320).div(10000), b: usdcUnit(3000).div(10000)}
        ];

        let totalLev = ether(3.24);   // summation of q element + 1 in leverParams
        
        for(let param of leverParams) {
          await ctx.ct.aaveLeverageModule.lever(
            bearIndex.address,
            btc.address,
            usdc.address,
            param.q,
            ZERO,
            UNISWAP_INTEGRATION,
            "0x"
          );
        } 

        await advanceTime(years);
        await ctx.ct.streamingFee.accrueFee(bearIndex.address);

        await ctx.aaveFixture.setAssetPriceInOracle(usdc.address, ether(0.001125));  // 1 ETH = 1250 usdc 
        await ctx.changeUniswapPrice(
          owner, 
          btc, 
          usdc, 
          usdcUnit(8889), 
          usdcUnit(10000),
          bitcoin(40),
          usdcUnit(400000),
          bitcoin 
        );
        // verify uniswap pricing is as expected 
        let usdcAmountOut = (await ctx.router.getAmountsOut(bitcoin(1), [btc.address, usdc.address]))[1];
        expect(usdcAmountOut).to.be.approx(usdcUnit(8889));

        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(bearIndex.address, quantities[0], alice.address, MAX_UINT_256);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(bearIndex.address, quantities[1], bob.address, ZERO);
        await aUsdcTracker.push(bearIndex.address);
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        let bobRedeem = usdcTracker.lastEarned(bob.address);
        let aliceIssue = usdcTracker.lastSpent(alice.address);
          
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(bearIndex.address, quantities[0], alice.address, ZERO);
        
        await usdcTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await aUsdcTracker.push(bearIndex.address);
        
        let aliceRedeem = (usdcTracker.lastEarned(alice.address));

        // 0.0000125 * 1000 * 2.24 / 0.0001125
        let expectedBobProfit = usdcUnit(248);
        let expectedBobFundsWithoutStreamFees =(expectedBobProfit.add(redeemables[1])) ;
        let feeNotional = preciseMul(expectedBobFundsWithoutStreamFees, ether(0.02));   // fee received by manager

        // Bob pays some of funds because of fees accrued by manager
        let expectedBobFunds = expectedBobFundsWithoutStreamFees.sub(feeNotional);

        let recipientIndexBalance = await bearIndex.balanceOf(protocolFeeRecipient.address);
        
        await ctx.ct.issuanceModule.connect(protocolFeeRecipient.wallet).redeem(bearIndex.address, recipientIndexBalance, protocolFeeRecipient.address, ZERO);

        expect(await bearIndex.totalSupply()).to.be.eq(ether(0));     // all redeemed 
        expect(await bearIndex.balanceOf(bob.address)).to.be.eq(ether(0));
        expect(await bearIndex.balanceOf(alice.address)).to.be.eq(ether(0));

        expect(await ctx.aTokens.aUsdc.balanceOf(bearIndex.address)).to.be.lt(BigNumber.from(10)); //  ~ 5e-6 
        expect(bobRedeem).to.be.approx(expectedBobFunds);
        expect(aliceIssue).to.be.approx(aliceRedeem);  // 
      });
      // TODO: Leverage after price rise (should be no profit)
      it("", async function () {
        // - issueA -> price rise much -> leverage 
      });
    });
    // : bot scenario ; NOTE this complex test requires new uniswap fixture
    // - issueA -> price rise much -> leverage 
    // - issueB -> price plummet -> bot intervene to delever
    // - price plummet again to reach first price
    // - redeemA : initFunds
    // - redeemB : huge loss
    describe("", async function() {
      let ctx: Context;
      let bob: Account;
      let alice: Account;
      let protocolFeeRecipient: Account;
      let owner: Account;
      let weth : Contract;
      let dai: StandardTokenMock;
      let daiTracker: BalanceTracker;
      let wethTracker: BalanceTracker;
      let aWethTracker: BalanceTracker;
      let aaveLender: AaveV2LendingPool;
      let zToken: SetToken;
      beforeEach ("", async function () {
        ctx = new Context();
        await ctx.initialize(true);  // Mock uniswap
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
      it("Scenario users issue and redeem after and before leveraging with price change ", async function() {
        // issueA -> price ΔΔ  -> leverage -> issueB -> 
        // price ∇ -> bot delever -> price ∇ -> redeemB & A
        let bot = ctx.accounts.others[0];
        await ctx.ct.aaveLeverageModule.updateAnyBotAllowed(zToken.address, true);
        await ctx.ct.aaveLeverageModule.setCallerPermission(zToken.address, bot.address, true);

        let quantities = [ether(0.02), ether(0.01), ether(0.01)];
        let redeemables = [ether(0.02), ether(0.01), ether(0.01)];  //   
        let fee  =  ether(0.0005);  // this is approx swap fee;
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantities[0], alice.address, MAX_UINT_256);
        
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);

        let leverParams = [
          {q: ether(1600), b: ether(0.75)},
          {q: ether(1220), b: ether(0.6)},
          {q: ether(1000), b: ether(0.45)},
          {q: ether(640), b: ether(0.3)}
        ];
        // let lev = 3.23;

        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.0005));  // 1 ETH = 2000 dai
        await (ctx.router! as UniswapV2Router02Mock).setPrice(weth.address, dai.address, ether(2000));

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
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.00055));  // 1 ETH = 1818.18 dai
        await (ctx.router! as UniswapV2Router02Mock).setPrice(weth.address, dai.address, ether(1818.18));


        // Delever to reach leverage 1.95x
        await ctx.ct.aaveLeverageModule.connect(bot.wallet).autoDelever(
          zToken.address,
          weth.address,
          dai.address,
          ether(0.32),
          ether(0),
          UNISWAP_INTEGRATION,
          "0x"
        );
        await ctx.ct.aaveLeverageModule.connect(bot.wallet).autoDelever(
          zToken.address,
          weth.address,
          dai.address,
          ether(0.5),
          ether(0),
          UNISWAP_INTEGRATION,
          "0x"
        );
        
        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.000625));  // 1 ETH = 1600 dai
        await (ctx.router! as UniswapV2Router02Mock).setPrice(weth.address, dai.address, ether(1600));
        
        // Delever to reach leverage 1x
        await ctx.ct.aaveLeverageModule.connect(bot.wallet).autoDelever(
          zToken.address,
          weth.address,
          dai.address,
          ether(0.5),
          ether(0),
          UNISWAP_INTEGRATION,
          "0x"
        );   
        await ctx.ct.aaveLeverageModule.connect(bot.wallet).autoDelever(
          zToken.address,
          weth.address,
          dai.address,
          ether(0.4),
          ether(0),
          UNISWAP_INTEGRATION,
          "0x"
        ); 

        await ctx.aaveFixture.setAssetPriceInOracle(dai.address, ether(0.001));  // 1 ETH = 1000 dai
        await (ctx.router! as UniswapV2Router02Mock).setPrice(weth.address, dai.address, ether(1000));

        await wethTracker.pushMultiple([bob.address, alice.address]);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, quantities[1], bob.address, ZERO);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, quantities[0], alice.address, ZERO);
        await wethTracker.pushMultiple([bob.address, alice.address]);
        let bobRedeem = wethTracker.lastEarned(bob.address);
        let aliceRedeem = wethTracker.lastEarned(alice.address);

        // loss on  price dips  
        // loss1 = 0.02*2.23*0.00005*1000 = 0.00223
        // loss2 =  0.02*0.95*0.000075 * 1000 = 0.001425
        // expectedAliceRedeem = 0.02 - loss1 - loss2
        let expectedAliceRedeem = ether(0.016);
        expect(aliceRedeem).to.be.approx(expectedAliceRedeem, 0.1);      // ~ 14484818666666636
        expect(aliceRedeem).to.be.lt(expectedAliceRedeem);      
        expect(bobRedeem).to.be.approx(expectedAliceRedeem.div(2), 0.1);
      });
    });
});