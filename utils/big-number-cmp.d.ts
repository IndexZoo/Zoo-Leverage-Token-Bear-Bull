import { BigNumber } from "ethers";

declare global {
  export namespace Chai {
      interface Assertion {
          approx(bn: BigNumber, delta?: number): Promise<void>;
      }
  }
}