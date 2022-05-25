import hre, { ethers } from "hardhat";
import { ADDRESS_ZERO, MAX_UINT_256 } from "../utils/constants";
import { Controller } from "../typechain-types/Controller";
import { SetTokenCreator } from "../typechain-types/SetTokenCreator";
import { Lev3xIssuanceModule } from "../typechain-types/Lev3xIssuanceModule";

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { HardhatNetworkConfig  } from "hardhat/types";
import { Lev3xAaveLeverageModule__factory } from "@typechain/factories/Lev3xAaveLeverageModule__factory";

import D from "./deployments";
import { Lev3xIssuanceModule__factory } from "@typechain/factories/Lev3xIssuanceModule__factory";
import { Lev3xAaveLeverageModule } from "@typechain/Lev3xAaveLeverageModule";

interface HreDto extends HardhatNetworkConfig{
  lendingPoolAddressesProvider: string,
  uniswapRouterAddress: string,
  weth: string
}


async function main() {
    const netConfig = hre.network.config as HreDto;
    const deployer: SignerWithAddress = (await ethers.getSigners())[0];
  
    console.log("Deploying contracts with the account:", deployer.address);
  
    console.log("Account balance:", (await deployer.getBalance()).toString());

    let indexUtilsLib = await (await ethers.getContractFactory("IndexUtils")).deploy();
    let aaveV2Lib = await (await ethers.getContractFactory("AaveV2")).deploy();
    let Lev3xAaveLeverageModuleFactory = await ethers.getContractFactory(
      "Lev3xAaveLeverageModule",{
        libraries: {
          AaveV2: aaveV2Lib.address,
          IndexUtils: indexUtilsLib.address
        } 
      });
  
    const Lev3xIssuanceModuleFactory: Lev3xIssuanceModule__factory = await ethers.getContractFactory(
      "Lev3xIssuanceModule", {
        libraries: {
          IndexUtils: indexUtilsLib.address
        }
      }
    );
    let controller: Controller = await ethers.getContractAt("Controller", D.polygon.controller);
    console.log("Controller address: ", controller.address);
    let lev3xIssuanceModule: Lev3xIssuanceModule = await Lev3xIssuanceModuleFactory.deploy(
        controller.address,
        netConfig.lendingPoolAddressesProvider
    );
    console.log("Lev3xIssuanceModule : ", lev3xIssuanceModule.address);

    let lev3xAaveLeverageModule: Lev3xAaveLeverageModule = await Lev3xAaveLeverageModuleFactory.deploy(
        controller.address,
        netConfig.lendingPoolAddressesProvider
    );
    console.log("Lev3xAaveLeverageModule : ", lev3xAaveLeverageModule.address);

    // let setTokenCreator: SetTokenCreator = await (await ethers.getContractFactory("SetTokenCreator")).deploy(controller.address);
    // console.log("SetTokenCreator address: ", setTokenCreator.address);
}

  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });