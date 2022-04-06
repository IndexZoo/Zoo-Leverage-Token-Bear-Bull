
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
import { BigNumber } from "ethers";
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
    describe("Slippage ", async function () {
      let btcIndex: SetToken;  // usdc base
      let btc: StandardTokenMock;
      let aBtc: any;
      let btcTracker: BalanceTracker ;
      let aBtcTracker: BalanceTracker;
      let usdc: StandardTokenMock;
      let subjectCall: (x: BigNumber) => Promise<void>;
      let subjectRedeemCall: (x: BigNumber) => Promise<void>;
      let ERROR_STRING = "amount exceeded slippage";
      let REDEEM_ERROR_STRING = "amount less than slippage";
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

        subjectCall = async (slippage: BigNumber) => {
          await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);
          await ctx.ct.issuanceModule.connect(alice.wallet).issue(
            btcIndex.address, 
            ether(0.1),
            alice.address,
            slippage 
          );
        };

        subjectRedeemCall = async (slippage: BigNumber) => {
          await btc.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);
          await ctx.ct.issuanceModule.connect(alice.wallet).redeem(
            btcIndex.address, 
            ether(0.1),
            alice.address,
            slippage
          );
        };
      }) ;
 
      it("Revert after issuing amount with not enough slippage", async function () {
        await expect(subjectCall(bitcoin(0.1).sub(1))).to.be.revertedWith(ERROR_STRING);
      });
      it("Verify issuing amount is successful with just enough slippage", async function () {
        await btcTracker.push(alice.address);
        await subjectCall(bitcoin(0.1));
        await btcTracker.push(alice.address);
        expect(btcTracker.lastSpent(alice.address)).to.be.eq(bitcoin(0.1));
      });

      it("Verify redemption is successful with enough slippage", async function () {
        await subjectCall(bitcoin(0.1));
        await btcTracker.push(alice.address);

        // trivial lever 
        await ctx.ct.aaveLeverageModule.lever(
          btcIndex.address,
          usdc.address,
          btc.address,
          usdcUnit(1),  // 
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );

        await subjectRedeemCall(bitcoin(0.1).sub(15));
        await btcTracker.push(alice.address);

        // check approx with low margin
        expect(btcTracker.lastEarned(alice.address)).to.be.approx(bitcoin(0.1), 0.0005); // ~ 9999992
      });

      it("Revert redemption due to low slippage limit", async function () {
        await subjectCall(bitcoin(0.1));
        await btcTracker.push(alice.address);

        // trivial lever 
        await ctx.ct.aaveLeverageModule.lever(
          btcIndex.address,
          usdc.address,
          btc.address,
          usdcUnit(1),  // 
          0,
          UNISWAP_INTEGRATION,
          "0x"
        );

        await expect(subjectRedeemCall(bitcoin(0.1).sub(1))).to.be.revertedWith(REDEEM_ERROR_STRING);
      });
    });
});