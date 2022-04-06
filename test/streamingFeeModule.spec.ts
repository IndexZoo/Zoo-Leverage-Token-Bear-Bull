
import "../utils/test/types";
import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { createFixtureLoader, solidity } from "ethereum-waffle";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2LendingPool} from "@setprotocol/set-protocol-v2/typechain/AaveV2LendingPool";

import {ether, approx, preciseMul} from "../utils/helpers";

import { Context } from "../utils/test/context";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_INT_256, MAX_UINT_256, ZERO } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "../utils/test/BalanceTracker";

import {initUniswapRouter} from "../utils/test/context";
import { WETH9 } from "@typechain/WETH9";
import { BigNumber, ContractTransaction, Wallet } from "ethers";
import { UniswapV2Router02 } from "@setprotocol/set-protocol-v2/typechain/UniswapV2Router02";
import { SetToken } from "@typechain/SetToken";
import {usdc as usdcUnit, bitcoin} from "../utils/common/unitsUtils";
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
      let protocolFeeRecipient: Account;
      let weth: WETH9;
      let dai: StandardTokenMock;
      let daiTracker: BalanceTracker;
      let aaveLender: AaveV2LendingPool;
      let zToken: SetToken;
      let aWethTracker: BalanceTracker;
      let indexTracker: BalanceTracker;
      let wethTracker: BalanceTracker;
      let UNISWAP_INTEGRATION = "UNISWAP";

      beforeEach("", async function(){
        ctx = new Context();
        await ctx.initialize(false);  // 
        bob = ctx.accounts.bob;
        owner = ctx.accounts.owner;
        protocolFeeRecipient = ctx.accounts.protocolFeeRecipient;
        alice = ctx.accounts.alice;
        weth = ctx.tokens.weth as WETH9;
        dai = ctx.tokens.dai;
        daiTracker = new BalanceTracker(dai);

        aaveLender = ctx.aaveFixture.lendingPool;
        zToken = ctx.sets[0];
        aWethTracker = new BalanceTracker(ctx.aTokens.aWeth);
        indexTracker = new BalanceTracker(zToken as any as StandardTokenMock);
        wethTracker = new BalanceTracker(ctx.tokens.weth as any as StandardTokenMock);
      });
    describe("Issue and redeem with price change ", async function(){
      it("verify fee recipient recieves amount of setToken", async function() {
        let quantity = ether(0.02);
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        
        await advanceTime(2);
        await indexTracker.push(protocolFeeRecipient.address);
        await ctx.ct.streamingFee.accrueFee(zToken.address);
        await indexTracker.push(protocolFeeRecipient.address);
        expect(indexTracker.lastEarned(protocolFeeRecipient.address)).to.be.approx(ether(0.0004), 0.03);  // ~ 408163304899734
        expect(await zToken.totalSupply()).to.be.approx(ether(0.0204));
      });

      it("Issue then verify redeem of all Z balance after leveraging for Bob and price rise", async function() {
        let quantity = ether(0.02);
        let fee = ether(0.01);
        let years = 2;
        await weth.connect(bob.wallet).approve(ctx.ct.issuanceModule.address, quantity);

        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        await ctx.ct.issuanceModule.connect(bob.wallet).issue(zToken.address, quantity, bob.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
        await wethTracker.push(bob.address);
        
        await advanceTime(years);
        await indexTracker.push(protocolFeeRecipient.address);
        await ctx.ct.streamingFee.accrueFee(zToken.address);
        await indexTracker.push(protocolFeeRecipient.address);

        await ctx.ct.aaveLeverageModule.lever(
          zToken.address,
          dai.address,
          weth.address,
          ether(0.000001),
          0,
          UNISWAP_INTEGRATION,
          "0x" 
        );
        
        await ctx.ct.issuanceModule.connect(bob.wallet).redeem(zToken.address, quantity, bob.address, ZERO);
        await wethTracker.push(bob.address);
        let bobFunds = wethTracker.lastEarned(bob.address);

        //   quantity / (quantity + quantity * fee * years)  * quantity
        let expectedBobFunds = quantity.mul(quantity).div(preciseMul(quantity, ether(1).add(fee.mul(years))));

        let feeRecipientBalance = await zToken.balanceOf(protocolFeeRecipient.address);
        await wethTracker.push(protocolFeeRecipient.address);
        await ctx.ct.issuanceModule.connect(protocolFeeRecipient.wallet).redeem(zToken.address, feeRecipientBalance, protocolFeeRecipient.address, ZERO);
        await wethTracker.push(protocolFeeRecipient.address);
        let feeRecipientFunds = wethTracker.lastEarned(protocolFeeRecipient.address);
        let expectedFeeRecipientFunds = quantity.sub(expectedBobFunds);

        expect(bobFunds).to.be.approx(expectedBobFunds);
        expect(feeRecipientFunds).to.be.approx(expectedFeeRecipientFunds, 0.03);
      });
    });
});