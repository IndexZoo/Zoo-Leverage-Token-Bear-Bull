import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber } from "ethers";
import {
  ether, 
  approx, 
  preciseDiv,
  preciseMul
} from "../utils/helpers";

import "./types";
import { Context } from "./context";
import { Account } from "@utils/types";
import { MAX_INT_256, MAX_UINT_256 } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "./BalanceTracker";
import { SetToken } from "@typechain/SetToken";



chai.use(solidity);
chai.use(approx);

const advanceTime = async (duration: number): Promise<void> => {
  await ethers.provider.send('evm_increaseTime', [duration*3600*24*365.25]); // duration in years 
}

describe("Composite IssuanceModule ", function () {
  let ctx: Context;
  let bob: Account;
  let manager: Account;
  let dai: StandardTokenMock;
  let daiTracker: BalanceTracker;
  let setTokenTracker: BalanceTracker;
  let setToken: SetToken;

    describe("Testing Issuing and redeeming using mocked uniswap fixture", async function () {
      beforeEach("", async () => {
        ctx = new Context();
        await ctx.initialize();
        setToken = ctx.sets[0];
        bob = ctx.accounts.bob;
        dai = ctx.tokens.dai;
        daiTracker = new BalanceTracker(dai);
      });
      it("check amount of dai spent to issue 1 index", async function () {
        /**
         * Bob issues 200 dai worth of index ~ 1 index
         * Verify that Bob spent that amount of dai to issue the index
         */
        let daiPerUnit = ether(200);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          ether(1),
          ctx.accounts.bob.address,
          ether(1).mul(202)
        );
        await daiTracker.push(bob.address);
        expect(daiTracker.totalSpent(bob.address)).to.eq(daiPerUnit);
      });

      it("issue amount of 1 index", async function () {
        /**
         * Bob issues 200 dai worth of index ~ 1 index
         * Verify that Bob ended up with balance of 1 index ~ 1e18
         */
        let daiPerUnit = ether(200);
        let quantity = ether(1);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          preciseMul(quantity, ether(202))
        );
        await daiTracker.push(bob.address);
        expect(await setToken.balanceOf(bob.address)).to.be.eq(quantity);
      });

      it("Redeem amount of 0.5 index", async function () {
        /**
         * Bob issues 200 dai worth of index ~ 1 index
         * Bob redeems 0.5 index ~ 100 dai
         * Bob expected to have spent 100 dai overall (i.e. spent 200 then gained 100)
         */
        let daiPerUnit = ether(200);    // amount of dai per index
        let quantity = ether(1);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          preciseMul(quantity, ether(202))
        );
        await daiTracker.push(bob.address);
        await  ctx.subjectModule!.connect(bob.wallet).redeem(
          setToken.address,
          quantity.div(2),
          bob.address,
          daiPerUnit.div(2).mul(95).div(100) 
        );
        await daiTracker.push(bob.address);
        expect(daiTracker.totalSpent(bob.address)).to.be.eq(daiPerUnit.div(2));
      });
    });

    describe("Testing Issuing and redeeming using real uniswap fixture", async function () {
      beforeEach("", async () => {
        ctx = new Context();
        await ctx.initialize(false);
        setToken = ctx.sets[0];
        bob = ctx.accounts.bob;
        dai = ctx.tokens.dai;
        daiTracker = new BalanceTracker(dai);
      });
      it("check amount of dai spent to issue 0.01 index", async function () {
        /**
         * Bob issues 2 dai worth of index ~ 0.01 index
         * Verify that Bob spent that amount of dai to issue the index
         */
        let daiIn = ether(2);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          ether(0.01),
          ctx.accounts.bob.address,
          ether(0.01).mul(204)
        );
        await daiTracker.push(bob.address);

        expect(daiTracker.totalSpent(bob.address)).to.gt(daiIn);
        expect(daiTracker.totalSpent(bob.address)).to.be.approx(daiIn);
      });

      it("issue amount of .01 index and veryify index balance is exactly equal that", async function () {
        /**
         * Bob issues about 2 dai worth of index ~ 0.01 index
         * Verify that Bob ended up with balance of 0.01 index ~ 1e16
         */
        let daiIn = ether(2);
        let quantity = ether(0.01);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          preciseMul(quantity, ether(202))
        );
        expect(await setToken.balanceOf(bob.address)).to.be.eq(quantity);
      });

      it("Redeem amount of 0.5 index", async function () {
        /**
         * Bob issues 2 dai worth of index ~ 0.01 index
         * Bob redeems 0.005 index ~ 1 dai
         * Bob expected to have spent about 1 dai overall (i.e. spent 2 then gained 1)
         * Bob is expected though to have spent little more than 1 dai (i.e. uniswap fees)
         */
        
        let daiIn = ether(2);    // amount of dai per index
        let quantity = ether(0.01);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          preciseMul(quantity, ether(204))
        );
        await daiTracker.push(bob.address);
        await  ctx.subjectModule!.connect(bob.wallet).redeem(
          setToken.address,
          quantity.div(2),
          bob.address,
          daiIn.div(2).mul(95).div(100) 
        );
        await daiTracker.push(bob.address);
        expect(daiTracker.totalSpent(bob.address)).to.be.gt(daiIn.div(2));  // due to uniswap fees
        expect(daiTracker.totalSpent(bob.address)).to.be.approx(daiIn.div(2));
      });

      it("Redeem all amount of index", async function () {
        /**
         * Bob issues 2 dai worth of index ~ 0.01 index
         * Bob redeems all index by using MAX_UINT_256 as quantity ~ 2 dai
         * Bob expected to have spent about 0 dai overall 
         * Bob is expected though to have spent little dai (i.e. gone as uniswap fees)
         */
        
        let daiIn = ether(2);    // amount of dai per index
        let quantity = ether(0.01);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          preciseMul(quantity, ether(204))
        );
        await daiTracker.push(bob.address);
        await  ctx.subjectModule!.connect(bob.wallet).redeem(
          setToken.address,
          MAX_UINT_256,
          bob.address,
          daiIn.mul(95).div(100) 
        );
        await daiTracker.push(bob.address);
        expect(daiTracker.totalSpent(bob.address)).to.be.gt(ether(0));  // due to uniswap fees
        expect(daiTracker.totalSpent(bob.address)).to.be.lt(ether(0.02));

        let expectedSwapFees = daiIn.mul(6).div(1000);                    // expected fees from the two swaps
        expect(daiTracker.totalSpent(bob.address)).to.be.approx(expectedSwapFees);
      });

      it("Redeem amount of index more than actual balance", async function () {
        /**
         * Bob issues 2 dai worth of index ~ 0.01 index
         * Bob redeems more index than he actually has
         * Revert expected
         */
        
        let daiIn = ether(2);    // amount of dai per index
        let quantity = ether(0.01);
        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          preciseMul(quantity, ether(204))
        );
        await daiTracker.push(bob.address);
        let tx = () =>  ctx.subjectModule!.connect(bob.wallet).redeem(
          setToken.address,
          quantity.add(1),
          bob.address,
          daiIn.mul(95).div(100) 
        );
        await expect( tx()).to.be.revertedWith("Not enough index");
      });
    });

     describe("Testing Issuing and redeeming using real uniswap fixture", async function () {
      beforeEach("", async () => {
        ctx = new Context();
        await ctx.initialize(false);
        setToken = ctx.sets[0];
        bob = ctx.accounts.bob;
        manager = ctx.accounts.protocolFeeRecipient;
        dai = ctx.tokens.dai;
        daiTracker = new BalanceTracker(dai);
        setTokenTracker = new BalanceTracker(setToken as any as StandardTokenMock);
      });

      it("Accrue fee and verify inflation amount", async function () {
        /**
         * Bob issues 1 dai worth of index ~ 0.005 index
         * Manager accrues his fee after 10 years ~ 10%
         * verify total supply increases by amount of manager gained fee
         * verify that positionMultiplier decreseases by ether(0.1)
         */
        
        let daiIn = ether(2).div(2);    // amount of dai per index due to inflation multiplier = 0.5
        let quantity = ether(0.005);
        let feePrecent = ether(0.1);
        let expectedFee = preciseMul (feePrecent, preciseDiv(quantity, ether(1).sub(feePrecent)));   // index quantity to be paid to manager
        let expectedSupply = expectedFee.add(quantity);
        let expectedMultiplier = ether(1).sub(feePrecent);

        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await setTokenTracker.push(manager.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          ether(2.04).div(2)
        );
        await advanceTime(10);
        await ctx.ct.streamingFee.accrueFee(setToken.address);
        await setTokenTracker.push(manager.address);

        expect(await setToken.totalSupply()).to.be.approx(expectedSupply);
        expect(setTokenTracker.totalEarned(manager.address)).to.be.approx(expectedFee);
        expect(await setToken.positionMultiplier()).to.be.approx(expectedMultiplier);
      });
      it("Accrue fee to manager and verify redeem amounts", async function () {
        /**
         * Bob issues 1 dai worth of index ~ 0.005 index
         * Manager accrues his fee after 10 years ~ 10%
         * Bob redeems all
         * Verify remaining collateral of setToken is the right amount
         * Manager then redeems all
         * Verify Manager gained right amount of dai out of this
         * Verify collateral of setToken is almost nilled. 
         * Verify there's no more supply of setToken
         */
        
        let daiIn = ether(1);    // amount of dai per index due to inflation multiplier = 0.5
        let quantity = ether(0.005);
        let duration = 10;       // years
        let feePrecent = ether(0.1);
        let wethCollateral = daiIn.div(1000).div(2);
        let expectedFee = preciseMul (feePrecent, preciseDiv(quantity, ether(1).sub(feePrecent)));   // index quantity to be paid to manager
        let expectedSupply = expectedFee.add(quantity);
        let expectedMultiplier = ether(1).sub(feePrecent);

        await ctx.tokens.dai.connect(bob.wallet).approve(ctx.subjectModule!.address, MAX_INT_256);
        await daiTracker.push(bob.address);
        await setTokenTracker.push(manager.address);
        await ctx.subjectModule!.connect(ctx.accounts.bob.wallet).issue(
          setToken.address,
          quantity,
          ctx.accounts.bob.address,
          ether(2.04).div(2)
        );
        await advanceTime(duration);
        await ctx.ct.streamingFee.accrueFee(setToken.address);
        await setTokenTracker.push(manager.address);

        await daiTracker.push(bob.address);
        expect(await ctx.tokens.weth.balanceOf(setToken.address)).to.be.eq(wethCollateral);
        
        await  ctx.subjectModule!.connect(bob.wallet).redeem(
          setToken.address,
          quantity,
          bob.address,
          daiIn.mul(85).div(100) 
        );
        expect(await ctx.tokens.weth.balanceOf(setToken.address)).to.be.approx(wethCollateral.div(duration));
        await daiTracker.push(bob.address);
        await daiTracker.push(manager.address);
        await  ctx.subjectModule!.connect(manager.wallet).redeem(
          setToken.address,
          await setToken.balanceOf(manager.address),
          manager.address,
          0 
        );
        await daiTracker.push(manager.address);
        expect(daiTracker.totalEarned(manager.address)).to.be.approx(daiIn.div(10));
        expect(await ctx.tokens.weth.balanceOf(setToken.address)).to.be.approx(BigNumber.from(1));
        expect(await ctx.tokens.btc.balanceOf(setToken.address)).to.be.approx(BigNumber.from(1));
        expect(await setToken.totalSupply()).to.be.eq(ether(0));
      });
    });   
});