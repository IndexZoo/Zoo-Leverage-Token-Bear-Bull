import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

export type Address = string;

export type Account = {
  address: Address;
  wallet: SignerWithAddress;
};