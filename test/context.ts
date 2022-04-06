import "module-alias/register";
import "./types";

import { Account } from "@utils/types";
import {  MAX_UINT_256, ZERO } from "../utils/constants";

import { ethers } from "hardhat";
import { bitcoin, ether } from "../utils/common/unitsUtils";

import {BigNumber, Contract} from "ethers";
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
import { getUniswapFixture } from "@setprotocol/set-protocol-v2/dist/utils/test";
import { UniswapV2Router02 } from "@setprotocol/set-protocol-v2/typechain/UniswapV2Router02";



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
      await router.addLiquidity(weth.address, dai.address, ether(40), ether(40000), ether(39), ether(39900), owner.address, MAX_UINT_256);
      await router.addLiquidity(btc.address, dai.address, bitcoin(40), ether(400000), ether(39), ether(399000), owner.address, MAX_UINT_256);
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
  others: Account[];
}

interface Tokens {
  weth: Contract;
  dai: StandardTokenMock;
  btc: StandardTokenMock;
}

interface Contracts {
  controller: Controller;
  zooToken: SetToken;
  creator: SetTokenCreator;
  streamingFee: StreamingFeeModule;
  integrator: IntegrationRegistry;
}


class Context {
  public accounts= <Accounts>{};
  public tokens = <Tokens> {};
  public ct = <Contracts> {};
  public sets: SetToken[] = [];
  public subjectModule?: CompositeSetIssuanceModule;

  public router?: UniswapV2Router02Mock | UniswapV2Router02;
  public exchangeAdapter?: UniswapV2ExchangeAdapterV3;

  public async setUniswapIntegration(): Promise<void> {
    await this.ct.integrator.addIntegration(
      this.subjectModule!.address,
      UNISWAP_ADAPTER_NAME,
      this.exchangeAdapter!.address
    )
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
      ...this.accounts.others
    ] = await getAccounts();
     
      /* ================================================== DeFi Fixtures ==================================================*/
      // this.aaveFixture = getAaveV2Fixture(this.accounts.owner.address);
      this.tokens.dai =  await (await ethers.getContractFactory("StandardTokenMock")).deploy(this.accounts.owner.address, ether(100000000), "MockDai", "MDAI", 18);
      this.tokens.btc = await (await ethers.getContractFactory("StandardTokenMock")).deploy(this.accounts.owner.address, bitcoin(1000000), "MockBtc", "MBTC", 8);
      this.tokens.weth = await new WETH9__factory(this.accounts.owner.wallet).deploy();

      await this.tokens.weth.connect(this.accounts.bob.wallet).deposit({value: ether(500)});
      await this.tokens.weth.deposit({value: ether(500)});
      await this.tokens.dai.transfer(this.accounts.bob.address, ether(2000));
      
      this.router = isMockDex? 
         await initUniswapMockRouter(this.accounts.owner, this.tokens.weth, this.tokens.dai, this.tokens.btc):
         await initUniswapRouter(this.accounts.owner, this.tokens.weth, this.tokens.dai, this.tokens.btc);      
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
      this.ct.integrator = await (await ethers.getContractFactory("IntegrationRegistry"))
        .deploy(this.ct.controller.address);

      await this.ct.controller.initialize(
        [this.ct.creator.address],
        [
          this.subjectModule.address,
          this.ct.streamingFee.address 
        ],
        [this.ct.integrator.address],
        [INTEGRATION_REGISTRY_RESOURCE_ID]
      );

      this.exchangeAdapter = await (await ethers.getContractFactory("UniswapV2ExchangeAdapterV3")).deploy(
        this.router!.address 
      );
      await this.setUniswapIntegration();
      await this.createSetToken();
  }
}


export {
  Context, 
  initUniswapMockRouter, 
  initUniswapRouter,
  pMul,
};
