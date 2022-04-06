import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { BigNumber } from "ethers";
import {ethers} from "hardhat"   ;

type TrackerT = Map<string, Array<BigNumber>>;
export class BalanceTracker {
    private token: StandardTokenMock;
    private balances: TrackerT;

    constructor(_token: StandardTokenMock) {
        this.balances = new Map<string, Array<BigNumber>> ();
        this.token = _token;
    }

    public async push (address: string) {
        let latestBalance = await this.token.balanceOf(address);
        if(this.balances.has(address)) {
            let list = this.balances.get(address);
            list!.push(latestBalance);
            this.balances.set(address, list!)
        } else {
            this.balances.set(address, [latestBalance]);
        }
    }

    public async pushMultiple (accounts: Array<string>) {
        for await (const x of accounts) {
           await this.push(x); 
        }
    }

    public totalEarned(address: string) : BigNumber | undefined {
        return this._earnedWithReversedIndex(address, -1);
    }

    public totalSpent(address: string) : BigNumber | undefined {
        return this._earnedWithReversedIndex(address, -1)?.mul(-1);
    }

    public lastEarned(address: string) : BigNumber | undefined {
        return this._earnedWithReversedIndex(address, 2);
    }

    private _earnedWithReversedIndex(address: string, index: number) : BigNumber | undefined {
        if (!this.balances.has(address))  return undefined;
        let list = this.balances.get(address);
        let n = list!.length;
        if (n <= 1) return BigNumber.from(0);
        return (index === -1)? list![n-1].sub(list![0]) : list![n-1].sub(list![n-index]);
    }
}