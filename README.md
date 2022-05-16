# Leverage Index 

## Test
- Install dependencies
```
yarn install
```
- Run scenario testing
```
yarn run test:scenarios
```

## How it works 
### Issue
- The collateral cost `I` required to issue a quantity `q` of SetToken is proportional to `q`. 
- The cost of issuing per unit of SetToken is dependent on the current leverage state `L` of SetToken and the current price `p` of the collateral asset vs the borrow asset.

> m<sub>i</sub> = (L<sub>i</sub>(1-p<sub>i-1</sub>/p<sub>i</sub>) - p<sub>i-1</sub>/p<sub>i</sub>)  * m<sub>i-1</sub>

> I = m<sub>i</sub> * q
  - Where `m` is issuing multiplier factor.

### Redeem
- Redemption `R` is reflecting the net asset value of the SetToken which equals to the difference between debt and collateral.
> R = (C - D) * q / T<sub>s</sub>
  - Where T<sub>s</sub> is total supply of SetToken
### Rebalance
- Rebalacing is achieved by a sequence of leverages or deleverages according to the current state of SetToken.
- Example
  - Suppose at first we have 1 WETH = 1000 DAI
  - Having SetToken with Collateral of 3 WETH vs Debt of 2 WETH per unit.
  - Leverage = 3 / (3-2) = 3
  - Price jumped:  1 WETH = 1600 DAI
  - Hence Collateral = 3 WETH vs Debt = 1.25 WETH
  - Need to borrow 3600 DAI = 2.25 WETH in order to end up with Leverage = 5.25 / (5.25 3.5) = 3.
  - To achieve that need to call:
```
lever(_setToken, dai, weth, 2.25*10**18, 2.2*10**18, "UNISWAP", "0x" )
```