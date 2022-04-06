import "../utils/test/types";
import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { createFixtureLoader, solidity } from "ethereum-waffle";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2LendingPool} from "@setprotocol/set-protocol-v2/typechain/AaveV2LendingPool";

import {ether, approx, preciseMul, bitcoin} from "../utils/helpers";

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

describe("Various tests: Accessor methods / events emitted / views", function () {
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
    describe("Bots testing -- accessor lever/delever", async function(){
      let revertString = "Must be the authorized caller";
      let subjectLeverMethod: (caller?: Account, x?: BigNumber) => Promise<ContractTransaction>;
      let subjectDeleverMethod: (caller?: Account, x?: BigNumber) => Promise<ContractTransaction>;
      let bot: Account;
      let quantity: BigNumber;
      beforeEach ("", async function(){
        quantity = ether(0.02);
        bot = ctx.accounts.others[0];
        subjectLeverMethod = async (
            caller: Account|undefined = owner,
            x: BigNumber|undefined = ether(800)
          ) =>
          await ctx.ct.aaveLeverageModule.connect(caller.wallet).autoLever(
            zToken.address,
            dai.address,
            weth.address,
            x,
            ether(0),
            UNISWAP_INTEGRATION,
            "0x"
          );

        subjectDeleverMethod = async (
            caller: Account|undefined = owner,
            x: BigNumber|undefined = ether(0.5)
          ) =>
          await ctx.ct.aaveLeverageModule.connect(caller.wallet).autoDelever(
            zToken.address,
            weth.address,
            dai.address,
            x,
            ether(0),
            UNISWAP_INTEGRATION,
            "0x"
          );

        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 

        await aWethTracker.push(zToken.address);
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity, alice.address, MAX_UINT_256);
        await aWethTracker.push(zToken.address);
      });
      it("Verify non authorized caller cannot access autoLever() even if manager", async function() {
        await expect(subjectDeleverMethod()).to.be.revertedWith(revertString);
        await expect(subjectDeleverMethod(bot)).to.be.revertedWith(revertString);
      });
      it("Verify non authorized caller cannot access autoDelever() call even if manager", async function() {
        await expect(subjectLeverMethod()).to.be.revertedWith(revertString);
        await expect(subjectLeverMethod(bot)).to.be.revertedWith(revertString);
      });

      it("Verify authorized bot calls autoLever() ", async function() {
        let expectedBorrowAmount = preciseMul(ether(0.8), (quantity));
        await ctx.ct.aaveLeverageModule.updateAnyBotAllowed(zToken.address, true);
        await ctx.ct.aaveLeverageModule.setCallerPermission(zToken.address, bot.address, true);

        await aWethTracker.push(zToken.address);
        await subjectLeverMethod(bot);
        await aWethTracker.push(zToken.address);

        expect(aWethTracker.lastEarned(zToken.address)).to.be.approx(expectedBorrowAmount);
      });

      it("Verify authorized bot calls autoDelever() ", async function() {
        let expectedRepayAmount = preciseMul(ether(0.5), (quantity));
        await ctx.ct.aaveLeverageModule.updateAnyBotAllowed(zToken.address, true);
        await ctx.ct.aaveLeverageModule.setCallerPermission(zToken.address, bot.address, true);

        await subjectLeverMethod(bot);
        await aWethTracker.push(zToken.address);
        await subjectDeleverMethod(bot);
        await aWethTracker.push(zToken.address);

        expect(aWethTracker.lastSpent(zToken.address)).to.be.approx(expectedRepayAmount);
      });

      it("Verify authorized bot reverts when calling autoLever(); bots not allowed ", async function() {
        await ctx.ct.aaveLeverageModule.setCallerPermission(zToken.address, bot.address, true);
        await expect(subjectLeverMethod(bot)).to.be.revertedWith(revertString);

      });
      it("Verify authorized bot reverts when calling autoDelever(); bots not allowed ", async function() {
        await ctx.ct.aaveLeverageModule.setCallerPermission(zToken.address, bot.address, true);
        await expect(subjectDeleverMethod(bot)).to.be.revertedWith(revertString);
      });

      it("Verify unauthorized bot reverts when calling autoLever(); bot not allowed ", async function() {
        await ctx.ct.aaveLeverageModule.updateAnyBotAllowed(zToken.address, true);
        await ctx.ct.aaveLeverageModule.setCallerPermission(zToken.address, bot.address, true);
        await expect(subjectLeverMethod(owner)).to.be.revertedWith(revertString);

      });

      it("Verify unauthorized bot reverts when calling autoDelever(); bot not allowed ", async function() {
        await ctx.ct.aaveLeverageModule.updateAnyBotAllowed(zToken.address, true);
        await ctx.ct.aaveLeverageModule.setCallerPermission(zToken.address, bot.address, true);
        await expect(subjectDeleverMethod(bob)).to.be.revertedWith(revertString);
      });
      // 
    });
    describe("Verify uniqueness of borrow asset", async function(){
      let subjectLeverMethod: (x: BigNumber, token: StandardTokenMock) => Promise<ContractTransaction>;
      let subjectDeleverMethod: (x: BigNumber, token: StandardTokenMock | WETH9) => Promise<ContractTransaction>;
      let quantity: BigNumber;
      beforeEach ("", async function(){
        quantity = ether(0.02);
        subjectLeverMethod = async (
            x: BigNumber ,
            token
          ) =>
          await ctx.ct.aaveLeverageModule.connect(owner.wallet).lever(
            zToken.address,
            token.address,
            weth.address,
            x,
            ether(0),
            UNISWAP_INTEGRATION,
            "0x"
          );

        subjectDeleverMethod = async (
            x: BigNumber ,
            token
          ) =>
          await ctx.ct.aaveLeverageModule.connect(owner.wallet).delever(
            zToken.address,
            weth.address,
            token.address,
            x,
            ether(0),
            UNISWAP_INTEGRATION,
            "0x"
          );
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 
        await ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity, alice.address, MAX_UINT_256);
      });
      it("Ensure inferior (uninitialized) asset can not be borrowed", async function(){
        await subjectLeverMethod( ether(800), dai);  
        await expect(subjectLeverMethod(bitcoin(6).div(10000), ctx.tokens.btc)).to.be.revertedWith("Borrow not enabled");      
      });

      it("Ensure inferior (uninitialized) asset can not be borrowed", async function(){
        await expect(subjectLeverMethod(bitcoin(6).div(10000), ctx.tokens.btc)).to.be.revertedWith("Borrow not enabled");      
      });

      it("Ensure initialized asset can be repaid", async function(){
        await subjectLeverMethod( ether(800), dai);  
        await subjectDeleverMethod(ether(0.75), ctx.tokens.dai );      
      });
      
      it("Ensure inferior (uninitialized) asset can not be repaid", async function(){
        await subjectLeverMethod( ether(800), dai);  
        await expect(subjectDeleverMethod(ether(0.75), ctx.tokens.btc )).to.be.revertedWith("Borrow not enabled");      
      });

    });

    describe("Events", async function () {
      let subjectIssueCall: () => Promise<ContractTransaction>;   
      beforeEach ("", async function () {
        let quantity = ether(0.01);
        subjectIssueCall = () => 
          ctx.ct.issuanceModule.connect(alice.wallet).issue(zToken.address, quantity, alice.address, MAX_UINT_256);
      });
      it("Verify event emitted on set index issue", async function () {
        await weth.connect(alice.wallet).approve(ctx.ct.issuanceModule.address, MAX_UINT_256);  // ∵ 
        await expect(subjectIssueCall()).to.emit(ctx.ct.issuanceModule, "SetTokenIssued");
      });
    });
 
});