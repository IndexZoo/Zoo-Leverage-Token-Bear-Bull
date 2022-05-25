require("dotenv").config();

import { HardhatUserConfig, task } from "hardhat/config";
import "@nomiclabs/hardhat-waffle";
import "@typechain/hardhat";

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
// task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
//   const accounts = await hre.ethers.getSigners();

//   for (const account of accounts) {
//     console.log(account.address);
//   }
// });

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

const config: HardhatUserConfig = {
  solidity: {
    version: "0.6.10",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true
    },
    rinkeby: {
      url: "https://eth-rinkeby.alchemyapi.io/v2/" + process.env.ALCHEMY_TOKEN,
      gas: 12000000,
      // url: "https://rinkeby.infura.io/v3/" + process.env.INFURA_TOKEN,
      // @ts-ignore
      accounts: [`0x${process.env.TEST_PRIVATE_KEY}`],
      // @ts-ignore
      weth: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"
    },
    polygon: {
      url: "https://polygon-mainnet.g.alchemy.com/v2/" + process.env.POLYGON_ALCHEMY_TOKEN,
      gas: 12000000,
      // @ts-ignore
      accounts: [`0x${process.env.PRODUCTION_LOWFEE_DEPLOY_PRIVATE_KEY}`],
      // @ts-ignore
      lendingPoolAddressesProvider: "0xd05e3E715d945B59290df0ae8eF85c1BdB684744",
      uniswapRouterAddress: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",  // Sushiswap 
      weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" 
    },
  },
  // @ts-ignore
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v5",
    externalArtifacts: ["external/**/*.json" ],
  },
};

export default config;
