import { BigNumber, ethers } from "ethers";

export function approx (_chai: Chai.ChaiStatic, _utils:any) {
  _chai.Assertion.addMethod('approx', function (bn: BigNumber, delta = 0.02) {
    var obj = this._obj as BigNumber;
    let deltabn = bn.mul(ether(delta)).div(ether(1));
    this.assert(
          bigNumberCloseTo(obj, bn, deltabn)
      , `expected ${obj.toString()} to be in between ${bn.sub(deltabn).toString()} ${bn.add(deltabn).toString()} but got ${obj.toString()}`
      , `expected ${obj.toString()} not in between ${bn.sub(deltabn).toString()} ${bn.add(deltabn).toString()}`
      , bn        // expected
      , obj   // actual
    );
  });
}

const bigNumberCloseTo = (a: BigNumber, n: BigNumber, delta = ether(0.1)) => 
         a.gt(n)? a.sub(n).lte(delta) : n.sub(a).lte(delta);

const ether = (amount: number | string): BigNumber => {
  const weiString = ethers.utils.parseEther(amount.toString());
  return BigNumber.from(weiString);
};

const {preciseMul: pMul} = require("@setprotocol/set-protocol-v2/dist/utils/common/mathUtils.js");
const preciseMul = (x: BigNumber, y:BigNumber)  => pMul(x, y) as BigNumber;
const {preciseDiv: pDiv} = require("@setprotocol/set-protocol-v2/dist/utils/common/mathUtils.js");
const preciseDiv = (x: BigNumber, y:BigNumber)  => pDiv(x, y) as BigNumber;

export {preciseMul, preciseDiv, ether, bigNumberCloseTo};