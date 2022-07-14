import hre, { ethers } from "hardhat";
import { Controller } from "../typechain-types/Controller";
import { Lev3xIssuanceModule } from "../typechain-types/Lev3xIssuanceModule";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { HardhatNetworkConfig  } from "hardhat/types";

import D from "./deployments";
import { Lev3xAaveLeverageModule } from "@typechain/Lev3xAaveLeverageModule";
import { SetTokenCreator } from "@typechain/SetTokenCreator";
import { ether } from "../utils/common/unitsUtils";
import { SetToken } from "@typechain/SetToken";
import { ADDRESS_ZERO } from "../utils/constants";
import { BigNumber } from "ethers";

let lev3xIssuanceModule: Lev3xIssuanceModule;
let lev3xAaveLeverageModule: Lev3xAaveLeverageModule;
let deployer: SignerWithAddress;

interface HreDto extends HardhatNetworkConfig{
  lendingPoolAddressesProvider: string,
  uniswapRouterAddress: string,
  weth: string
}


async function main() {
    const netConfig = hre.network.config as HreDto;
    deployer = (await ethers.getSigners())[0];
  
    console.log("Account balance:", (await deployer.getBalance()).toString());

    let controller: Controller = await ethers.getContractAt("Controller", D.polygon2.controller);
    console.log("Controller address: ", controller.address);
    lev3xIssuanceModule = await ethers.getContractAt("Lev3xIssuanceModule", D.polygon2.Lev3xIssuanceModule);
    console.log("Lev3xIssuanceModule : ", lev3xIssuanceModule.address);
    lev3xAaveLeverageModule = await ethers.getContractAt("Lev3xAaveLeverageModule", D.polygon2.Lev3xAaveLeverageModule);
    console.log("Lev3xAaveLeverageModule : ", lev3xAaveLeverageModule.address);
    // deploy new adapter Uniswapv2adapterv3 add integration UNISWAP

    // await createIndex();   // create new index
    let index = await ethers.getContractAt("SetToken", D.polygon2.mtcx3) as SetToken;
    await lev3xIssuanceModule .initialize(index.address, ether(0), ether(0), ether(0), deployer.address, ADDRESS_ZERO);

    // add integration for default issuance
    await lev3xAaveLeverageModule.updateAllowedSetToken(index.address, true);
    await lev3xAaveLeverageModule.initialize(index.address,  D.polygon2.wmatic, D.polygon2.dai);   // reverse if Bear Index
    await lev3xAaveLeverageModule.registerToModule(index.address, lev3xIssuanceModule.address);


    // issue index
    // approve wmatic
    // await lev3xIssuanceModule.issue("0xcd15de9546390f5ee242601d425cf92b812c420d", "1000000000000000", "0x55ec991D34569941a77e90b54Fcc3e687234FfCD", "1500000000000000")


    // leverage index
    // await levModule.lever("0xcd15de9546390f5ee242601d425cf92b812c420d", "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", ether(0.2), "0", "UNISWAP", "0x")

}

async function createIndex() {
    let setTokenCreator: SetTokenCreator = await ethers.getContractAt("SetTokenCreator", D.polygon2.setTokenCreator);

    await setTokenCreator.create(
      [D.polygon2.aWmatic], 
      [ether(1)], 
      [
        lev3xAaveLeverageModule.address,
        lev3xIssuanceModule.address
      ],  deployer.address, "wmatic Lev3x", "MTCx3");
}

async function createBearIndex() {
    let setTokenCreator: SetTokenCreator = await ethers.getContractAt("SetTokenCreator", D.polygon2.setTokenCreator);

    await setTokenCreator.create(
      [D.polygon2.adai], 
      [ether(0.001)], 
      [
        lev3xAaveLeverageModule.address,
        lev3xIssuanceModule.address
      ],  deployer.address, "Bear", "MTCBEAR");
}

  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });

