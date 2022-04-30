// ## TODOs ph1
// ### TODO: Multiple Leverage
// ### TODO: Convert token to aToken
// ### TODO: Add other token as basetoken
// ### TODO: Do bear trade
// ## TODOs ph2
// ### TODO: StreamFees
// ### TODO: Rebalance with price

import "module-alias/register";
import "./types";

import { Account } from "@utils/types";
import {  ADDRESS_ZERO, MAX_UINT_256, ZERO } from "../utils/constants";

import { ethers } from "hardhat";
import { bitcoin, ether } from "../utils/common/unitsUtils";

import {BigNumber, Contract} from "ethers";
import {AaveV2Fixture} from "@setprotocol/set-protocol-v2/dist/utils/fixtures";
import {AaveV2AToken} from "@setprotocol/set-protocol-v2/dist/utils/contracts/aaveV2";
import {StandardTokenMock} from "../typechain-types/StandardTokenMock";
import { UniswapV2Router02Mock } from "../typechain-types/UniswapV2Router02Mock";
import { Controller } from "../typechain-types/Controller";

import { SetToken } from "../typechain-types/SetToken";
import { SetTokenCreator } from "../typechain-types/SetTokenCreator";
import { StreamingFeeModule } from "../typechain-types/StreamingFeeModule";
import { getAccounts } from "../utils/common/accountUtils";
import { WETH9__factory } from "../typechain-types/factories/WETH9__factory";
import { CompositeSetIssuanceModule } from "../typechain-types/CompositeSetIssuanceModule";
import { abi as SetTokenABI } from "../artifacts/@setprotocol/set-protocol-v2/contracts/protocol/SetToken.sol/SetToken.json";
import { IntegrationRegistry } from "@typechain/IntegrationRegistry";
import { UniswapV2ExchangeAdapterV3 } from "@typechain/UniswapV2ExchangeAdapterV3";
// @ts-ignore
import { getUniswapFixture, getAaveV2Fixture } from "@setprotocol/set-protocol-v2/dist/utils/test";
import { UniswapV2Router02 } from "@setprotocol/set-protocol-v2/typechain/UniswapV2Router02";
import { IssuanceModule } from "@typechain/IssuanceModule";
import { Lev3xIssuanceModule } from "@typechain/Lev3xIssuanceModule";
import { Lev3xAaveLeverageModule } from "@typechain/Lev3xAaveLeverageModule";
import { Lev3xModuleIssuanceHook } from "@typechain/Lev3xModuleIssuanceHook";



const pMul = (b: BigNumber, x: number) => {
  return b.mul(ether(x)).div(ether(1));
}

const INTEGRATION_REGISTRY_RESOURCE_ID = 0;
const UNISWAP_ADAPTER_NAME = "UNISWAP";

const initUniswapMockRouter = async(owner: Account, weth:  Contract, dai:  StandardTokenMock, btc: StandardTokenMock): Promise<UniswapV2Router02Mock> => {
      let router: UniswapV2Router02Mock;
      router = await (await ethers.getContractFactory("UniswapV2Router02Mock")).deploy();
      await  weth.approve(router.address, MAX_UINT_256);
      await dai.approve(router.address, MAX_UINT_256);
      await btc.approve(router.address, MAX_UINT_256);

      await router.addLiquidity(weth.address, dai.address, ether(80), ether(80000), ether(79), ether(79900), owner.address, MAX_UINT_256);
      await router.addLiquidity(btc.address, dai.address, bitcoin(50), ether(500000), bitcoin(49), ether(499900), owner.address, MAX_UINT_256);
    
      return router;
}

const initUniswapRouter = async(owner: Account, weth:  Contract, dai:  StandardTokenMock, btc: StandardTokenMock): Promise<UniswapV2Router02> => {
      let router: UniswapV2Router02;

         let uniswapFixture =  getUniswapFixture(owner.address);
        await uniswapFixture.initialize(
          owner,
          weth.address,
          btc.address,
          dai.address
        );
        router = uniswapFixture.router;
      await  weth.approve(router.address, MAX_UINT_256);
      await dai.approve(router.address, MAX_UINT_256);
      await btc.approve(router.address, MAX_UINT_256);
      
      await router.addLiquidity(weth.address, dai.address, ether(45), ether(45000), ether(44.9), ether(44900), owner.address, MAX_UINT_256);
      await router.addLiquidity(btc.address, dai.address, bitcoin(40), ether(400000), ether(39.9), ether(399000), owner.address, MAX_UINT_256);
      return router;
}


interface Accounts {
  owner: Account;
  protocolFeeRecipient: Account;
  mockUser: Account;
  mockSubjectModule: Account;
  bob: Account;
  alice: Account;
  oscar: Account;
  seeder: Account;
  others: Account[];
}

interface Tokens {
  weth: Contract;
  dai: StandardTokenMock;
  btc: StandardTokenMock;
}

interface ATokens {
  aWeth: AaveV2AToken;
}

interface Contracts {
  controller: Controller;
  zooToken: SetToken;
  creator: SetTokenCreator;
  streamingFee: StreamingFeeModule;
  issuanceModule: Lev3xIssuanceModule;
  lev3xModuleIssuanceHook: Lev3xModuleIssuanceHook;
  aaveLeverageModule: Lev3xAaveLeverageModule;
  integrator: IntegrationRegistry;
}


class Context {
  public accounts= <Accounts>{};
  public tokens = <Tokens> {};
  public aTokens = <ATokens>{};
  public ct = <Contracts> {};
  public sets: SetToken[] = [];
  public subjectModule?: CompositeSetIssuanceModule;

  public router?: UniswapV2Router02Mock | UniswapV2Router02;
  public aaveFixture: AaveV2Fixture;
  public exchangeAdapter?: UniswapV2ExchangeAdapterV3;

  private currentWethUniswapLiquidity: BigNumber;

  public async changeUniswapPrice (owner: Account, weth:  Contract, dai:  StandardTokenMock, newPrice: BigNumber, initPrice: BigNumber): Promise<void>  {
    let k = ether(45).mul(ether(45000));
    let sqrtK = Math.sqrt(k.div(newPrice).div(ether(1)).toNumber());
    sqrtK = Math.round(sqrtK*10**4)/10**4;
    let sqrtKBN: BigNumber = ether(sqrtK);
    let amount =  this.currentWethUniswapLiquidity.sub(sqrtKBN).mul(101).div(100);  // *1.01 is a hack (factor)
    if(newPrice.gt(initPrice)) {
      // delta_w = w - sqrt(k / newPrice)
      // let amount = newPrice.sub(initPrice).mul(ether(45).mul(ether(0.96))).div(newPrice.add(initPrice)).div(ether(1));
      await this.router!.swapTokensForExactTokens(amount, MAX_UINT_256, [dai.address, weth.address], owner.address, MAX_UINT_256) ;
      this.currentWethUniswapLiquidity = this.currentWethUniswapLiquidity.add(amount);
    } else if(newPrice.lt(initPrice)) {
      amount = amount.mul(-1);
      await this.router!.swapExactTokensForTokens(amount, 0, [weth.address, dai.address], owner.address, MAX_UINT_256) ;
      this.currentWethUniswapLiquidity =  this.currentWethUniswapLiquidity.sub(amount);
    }
  }

  public async setUniswapIntegration(): Promise<void> {
    await this.ct.integrator.addIntegration(
      this.subjectModule!.address,
      UNISWAP_ADAPTER_NAME,
      this.exchangeAdapter!.address
    );
    await this.ct.integrator.addIntegration(
      this.ct.aaveLeverageModule.address,
      UNISWAP_ADAPTER_NAME,
      this.exchangeAdapter!.address
    );    
    await this.ct.integrator.addIntegration(
      this.ct.issuanceModule.address,
      UNISWAP_ADAPTER_NAME,
      this.exchangeAdapter!.address
    );
  }

  public async setIssuanceModuleIntegration(): Promise<void> {
    await this.ct.integrator.addIntegration(
      this.ct.aaveLeverageModule.address,
      "DefaultIssuanceModule",
      this.ct.issuanceModule.address 
    );
  }

 /**
   * @dev creates SetToken via a contract factory
   */
  public async createZToken(): Promise<void> {
      const tx =  await this.ct.creator.create(
        [this.aTokens.aWeth.address ],
        [ether(1) ],
        [
          this.ct.streamingFee.address,
          this.ct.aaveLeverageModule.address,
          this.ct.issuanceModule.address,
          this.ct.lev3xModuleIssuanceHook.address
        ], 
        this.accounts.owner.address, 
        "Lev3x", 
        "WethBull"
      );
      const receipt = await tx.wait();
      const event = receipt.events?.find(p => p.event == "SetTokenCreated");
      const tokensetAddress = event? event.args? event.args[0]:"":"";

      let deployedSetToken =  await ethers.getContractAt(SetTokenABI, tokensetAddress) as SetToken;
      this.sets.push(deployedSetToken );

      await this.ct.issuanceModule.initialize(
        deployedSetToken.address,
        ether(0),
        ether(0),
        ether(0),
        this.accounts.owner.address,
        ADDRESS_ZERO
      );

      await this.ct.streamingFee.initialize(
        deployedSetToken.address, {
         feeRecipient: this.accounts.protocolFeeRecipient.address,
         maxStreamingFeePercentage: ether(0.05),
         streamingFeePercentage: ether(0.01),
         lastStreamingFeeTimestamp: 0
      });

      await this.ct.aaveLeverageModule.updateAllowedSetToken(deployedSetToken.address, true);
      await this.ct.aaveLeverageModule.initialize(
        deployedSetToken.address,
        this.tokens.weth.address,
        this.tokens.dai.address
      );

      // -------------- Hooks -------------
      await this.ct.lev3xModuleIssuanceHook.initialize(deployedSetToken.address);
      await this.ct.lev3xModuleIssuanceHook.registerToIssuanceModule(deployedSetToken.address);

  }

 /**
   * @dev creates SetToken via a contract factory
   */
  public async createSetToken(): Promise<void> {
      const tx =  await this.ct.creator.create(
        [this.tokens.weth.address, this.tokens.btc.address ],
        [ether(0.1), ether(0.01) ],
        [
          this.subjectModule!.address, 
          this.ct.streamingFee.address
        ], 
        this.accounts.owner.address, 
        "Compo", 
        "BULL"
      );
      const receipt = await tx.wait();
      const event = receipt.events?.find(p => p.event == "SetTokenCreated");
      const tokensetAddress = event? event.args? event.args[0]:"":"";

      let deployedSetToken =  await ethers.getContractAt(SetTokenABI, tokensetAddress) as SetToken;
      this.sets.push(deployedSetToken );


      await this.subjectModule!.initialize(deployedSetToken.address, this.tokens.dai.address,  this.router!.address);
      await this.ct.streamingFee.initialize(
        deployedSetToken.address, {
         feeRecipient: this.accounts.protocolFeeRecipient.address,
         maxStreamingFeePercentage: ether(0.05),
         streamingFeePercentage: ether(0.01),
         lastStreamingFeeTimestamp: 0
      });

      // addToController
      let component = (await deployedSetToken.getComponents())[0];
      let externalModule  =   (await deployedSetToken.getExternalPositionModules(component ))[0];
      await this.ct.controller.addModule(externalModule);
      
      // add integration
      await this.ct.integrator.addIntegration(
        externalModule, 
        UNISWAP_ADAPTER_NAME, 
        this.exchangeAdapter!.address
      );

      // initializeHook
      await deployedSetToken.addModule(externalModule);
      await this.subjectModule!.initializeHook(deployedSetToken.address);

  }


    public async initialize(isMockDex: boolean = true) : Promise<void>  {
    [
      this.accounts.owner,
      this.accounts.protocolFeeRecipient,
      this.accounts.mockUser,
      this.accounts.mockSubjectModule,
      this.accounts.bob,
      this.accounts.alice,
      this.accounts.oscar,
      this.accounts.seeder,
      ...this.accounts.others
    ] = await getAccounts();
     
      /* ================================================== DeFi Fixtures ==================================================*/
      this.aaveFixture = getAaveV2Fixture(this.accounts.owner.address);
      this.tokens.dai =  await (await ethers.getContractFactory("StandardTokenMock")).deploy(this.accounts.owner.address, ether(100000000), "MockDai", "MDAI", 18);
      this.tokens.btc = await (await ethers.getContractFactory("StandardTokenMock")).deploy(this.accounts.owner.address, bitcoin(1000000), "MockBtc", "MBTC", 8);
      this.tokens.weth = await new WETH9__factory(this.accounts.owner.wallet).deploy();

      await this.tokens.weth.connect(this.accounts.bob.wallet).deposit({value: ether(50)});
      await this.tokens.weth.connect(this.accounts.alice.wallet).deposit({value: ether(50)});
      await this.tokens.weth.connect(this.accounts.seeder.wallet).deposit({value: ether(50)});
      await this.tokens.weth.deposit({value: ether(500)});
      await this.tokens.dai.transfer(this.accounts.bob.address, ether(2000));
      
      this.router = isMockDex? 
         await initUniswapMockRouter(this.accounts.owner, this.tokens.weth, this.tokens.dai, this.tokens.btc):
         await initUniswapRouter(this.accounts.owner, this.tokens.weth, this.tokens.dai, this.tokens.btc);      
      this.currentWethUniswapLiquidity = ether(45);

      await this.aaveFixture.initialize(this.tokens.weth.address, this.tokens.dai.address);
      await this.tokens.weth.approve(this.aaveFixture.lendingPool.address, MAX_UINT_256);
      await this.tokens.dai.approve(this.aaveFixture.lendingPool.address, MAX_UINT_256);
      await this.aaveFixture.lendingPool.deposit(
        this.tokens.weth.address,
        ether(10),
        this.accounts.owner.address,
        ZERO
      );
      await this.aaveFixture.lendingPool.deposit(
        this.tokens.dai.address,
        ether(10000),
        this.accounts.owner.address,
        ZERO
      );
      this.aTokens.aWeth = this.aaveFixture.wethReserveTokens.aToken;
      /* ============================================= Zoo Ecosystem ==============================================================*/
      this.ct.controller =  await (await ethers.getContractFactory("Controller")).deploy(
        this.accounts.protocolFeeRecipient.address
      );
      this.ct.creator =  await (await ethers.getContractFactory("SetTokenCreator")).deploy(
        this.ct.controller.address
      );
      this.subjectModule = await (await ethers.getContractFactory("CompositeSetIssuanceModule")).deploy(
        this.ct.controller.address
      );
      this.ct.streamingFee = await (await ethers.getContractFactory("StreamingFeeModule")).deploy(
        this.ct.controller.address
      );
      this.ct.issuanceModule  = await (await ethers.getContractFactory("Lev3xIssuanceModule")).deploy(
        this.ct.controller.address,
        this.aaveFixture.lendingPoolAddressesProvider.address
      );
      this.ct.lev3xModuleIssuanceHook = await (await ethers.getContractFactory("Lev3xModuleIssuanceHook")).deploy(
        this.ct.issuanceModule.address
      );
      let aaveV2Lib = await (await ethers.getContractFactory("AaveV2")).deploy();
      this.ct.aaveLeverageModule = await (await ethers.getContractFactory(
        "Lev3xAaveLeverageModule",{
          libraries: {AaveV2: aaveV2Lib.address} 
        })).deploy(
        this.ct.controller.address,
        this.aaveFixture.lendingPoolAddressesProvider.address 
      );
      this.ct.integrator = await (await ethers.getContractFactory("IntegrationRegistry"))
        .deploy(this.ct.controller.address);

      await this.ct.controller.initialize(
        [this.ct.creator.address],
        [
          this.subjectModule.address,
          this.ct.streamingFee.address,
          this.ct.aaveLeverageModule.address,
          this.ct.issuanceModule.address,
          this.ct.lev3xModuleIssuanceHook.address 
        ],
        [this.ct.integrator.address],
        [INTEGRATION_REGISTRY_RESOURCE_ID]
      );

      this.exchangeAdapter = await (await ethers.getContractFactory("UniswapV2ExchangeAdapterV3")).deploy(
        this.router!.address 
      );
      await this.setUniswapIntegration();
      await this.setIssuanceModuleIntegration();
      await this.createSetToken();
      await this.createZToken();
  }
}


export {
  Context, 
  initUniswapMockRouter, 
  initUniswapRouter,
  pMul,
};
