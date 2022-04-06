import chai, { Assertion, expect } from "chai";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber } from "ethers";
import {ether, approx} from "../utils/helpers";

import "./types";
import { Context } from "./context";
import { Account } from "@utils/types";
import { ADDRESS_ZERO, MAX_INT_256 } from "../utils/constants";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BalanceTracker } from "./BalanceTracker";

import {initUniswapRouter} from "./context";
chai.use(solidity);
chai.use(approx);


describe("Testing Ecosystem", function () {
  let ctx: Context;
  let bob: Account;
  let dai: StandardTokenMock;
  let daiTracker: BalanceTracker;
    beforeEach("", async () => {
      ctx = new Context();
      await ctx.initialize();
      bob = ctx.accounts.bob;
      dai = ctx.tokens.dai;
      daiTracker = new BalanceTracker(dai);
    });
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
    
    it("router -- xx ", async function () {
      let configs = await ctx.subjectModule!.configs(ctx.sets[0].address);
      expect(configs.router).to.be.eq(ctx.router!.address) ;
      expect(configs.quote).to.be.eq(ctx.tokens.dai.address) ;
    });

    it("real router", async function() {
      let amountIn = ether(0.1);
      let router = await initUniswapRouter(ctx.accounts.owner, ctx.tokens.weth, ctx.tokens.dai, ctx.tokens.btc);
      let amounts = await router.getAmountsOut(amountIn, [ctx.tokens.weth.address, ctx.tokens.dai.address]);
      expect(amounts[1]).to.be.approx(amountIn.mul(1000));
    });

});