
import "../utils/test/types";
import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { createFixtureLoader, solidity } from "ethereum-waffle";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2LendingPool} from "@setprotocol/set-protocol-v2/typechain/AaveV2LendingPool";

import {ether, approx, preciseMul} from "../utils/helpers";

import { Context } from "../utils/test/context";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_INT_256, MAX_UINT_256 } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "../utils/test/BalanceTracker";

import {initUniswapRouter} from "../utils/test/context";
import { WETH9 } from "@typechain/WETH9";
import { BigNumber, ContractTransaction, Wallet } from "ethers";
import { UniswapV2Router02 } from "@setprotocol/set-protocol-v2/typechain/UniswapV2Router02";
import { SetToken } from "@typechain/SetToken";
chai.use(solidity);
chai.use(approx);

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
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address);
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
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address);

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
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantities[0], alice.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address);
        await ctx.ct.issuanceModule.issue(zToken.address, quantities[2], owner.address);
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
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemables[0], alice.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address);
        await ctx.ct.issuanceModule.connect(owner.wallet).redeem(zToken.address, redeemables[2], owner.address);
        
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
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address);
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
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address);

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
        
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address);
        
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
        
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantities[0], alice.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address);

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        let bobRedeem = wethTracker.lastEarned(bob.address);
        let aliceIssue = wethTracker.lastSpent(alice.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemables[0], alice.address);
        
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
        
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantities[1], bob.address);
        
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
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, redeemables[1], bob.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantities[0], alice.address);

        await aWethTracker.push(zToken.address);
        await wethTracker.pushMultiple([bob.address, alice.address, owner.address]);
        
        let bobRedeem = wethTracker.lastEarned(bob.address);
        let aliceIssue = wethTracker.lastSpent(alice.address);        

        // Alice is receiving the residue of the LevToken because debt=0 hence swapFactor does not kick in
        await ctx.ct.issuanceModule.connect(alice.wallet).redeem(zToken.address, redeemables[0], alice.address);
        
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
});