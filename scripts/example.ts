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

    let controller: Controller = await ethers.getContractAt("Controller", D.polygon.controller);
    console.log("Controller address: ", controller.address);
    lev3xIssuanceModule = await ethers.getContractAt("Lev3xIssuanceModule", D.polygon.Lev3xIssuanceModule);
    console.log("Lev3xIssuanceModule : ", lev3xIssuanceModule.address);
    lev3xAaveLeverageModule = await ethers.getContractAt("Lev3xAaveLeverageModule", D.polygon.Lev3xAaveLeverageModule);
    console.log("Lev3xAaveLeverageModule : ", lev3xAaveLeverageModule.address);

    // await createIndex();
    let index = await ethers.getContractAt("SetToken", D.polygon2.mtcx3) as SetToken;
    // await lev3xIssuanceModule.initialize(index.address, ether(0), ether(0), ether(0), deployer.address, ZERO_ADDRESS);

    // create index and initialize with modules

    // deposit matic to wmatic
    // issue index
    // leverage index

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

  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });

function ZERO_ADDRESS(address: string, arg1: BigNumber, arg2: BigNumber, arg3: BigNumber, address: string, ZERO_ADDRESS: any) {
  throw new Error("Function not implemented.");
}
