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

## Doc

### Lev3x Issuance

#### issue
Deposits stable asset (e.g. usdc) to the index and mints quantity of the index leverage token. Amount of asset to be received is proportional to quantity.
```
function issue( ISetToken _setToken, uint256 _quantity, address _to, uint256 _maxEquityCost ) external
```
* **_setToken**         Instance of the SetToken to issue
* **_quantity**         Quantity of SetToken to issue
* **_to**               Address to mint SetToken to
* **_maxEquityCost**    Slippage

#### redeem
Returns components from the SetToken, unwinds any external module component positions and burns the SetToken. If the token has debt positions, the module transfers the equity after deducting the debt amount for the user.
redeemed_equity_per_index = (collateral - debt) * quantity / index_total_supply
```
function redeem(ISetToken _setToken, uint256 _quantity, address _to, uint256 _minEquityReceived ) external
```
* _setToken              Instance of the SetToken to redeem
* _quantity              Quantity of SetToken to redeem (be burnt)
* _to                    Address to send collateral to
* _minEquityReceived     For slippage (protect from sandwich attacks). Minimum amount of collateral asset to receive.

#### calculateEquityIssuanceCost
Calculates the amount of collateral asset needed to collateralize passed issue quantity of Sets that will be returned to caller. Can also be used to determine how much collateral will be returned on redemption. It calculates the total amount required of collateral asset for a given setToken quantity.
```
function calculateEquityIssuanceCost( ISetToken _setToken, uint256 _quantity, bool _isIssue ) external view
```

* **_setToken**         Instance of the SetToken to issue
* **_quantity**         Amount of Sets to be issued/redeemed
* **_isIssue**          Whether Sets are being issued or redeemed
* **_equityCost**      equity notional amounts of component, represented as uint256

### Lev3x Aave Leverage

#### lever
MANAGER ONLY: Increases leverage for a given base (collateral) token using an enabled borrow asset (e.g. usdc in bull case). Borrows _borrowAsset from Aave. Performs a DEX trade, exchanging the _borrowAsset for _collateralAsset. Deposits _collateralAsset to Aave and mints corresponding aToken.
Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this
on Initialize.
Note: example: 
```
lever(
     index.address,
     usdc.address,     // borrow asset
     weth.address,     // collateral asset 
     ether(800),       // quantityUnit = totalQuantityToBorrow/totalSupplyOfIndex
     ether(0.75),      // minQuantityUnit = totalQuantityToReceiveSwap/totalSupplyOfIndex
     "UNISWAP",
     "0x"
);
```

```
function lever(
    ISetToken _setToken,
    IERC20 _borrowAsset,
    IERC20 _collateralAsset,
    uint256 _borrowQuantityUnits,
    uint256 _minReceiveQuantityUnits,
    string memory _tradeAdapterName,
    bytes memory _tradeData
) external
```
* **_setToken**                     Instance of the SetToken
* **_borrowAsset**                  Address of underlying asset being borrowed for leverage
* **_collateralAsset**              Address of underlying collateral asset
* **_borrowQuantityUnits**          Borrow quantity of asset in position units
* **_minReceiveQuantityUnits**      Min receive quantity of collateral asset to receive post-trade in position units
* **_tradeAdapterName**             Name of trade adapter
* **_tradeData**                    Arbitrary data for trade

#### delever
MANAGER ONLY: Decrease leverage for a given collateral (base) token using an enabled borrow asset.
Withdraws _collateralAsset from Aave. Performs a DEX trade, exchanging the _collateralAsset for _repayAsset 
(i.e. borrowAsset). Repays _repayAsset to Aave and decreases leverage of index accordingly.

Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this on initialize.

```    
function delever(
    ISetToken _setToken,
    IERC20 _collateralAsset,
    IERC20 _repayAsset,
    uint256 _redeemQuantityUnits,
    uint256 _minRepayQuantityUnits,
    string memory _tradeAdapterName,
    bytes memory _tradeData
) external 
```
     
* **_setToken**                 Instance of the SetToken
* **_collateralAsset**          Address of underlying collateral asset being withdrawn
* **_repayAsset**               Address of underlying borrowed asset being repaid
* **_redeemQuantityUnits**      Quantity of collateral asset to delever in position units
* **_minRepayQuantityUnits**    Minimum amount of repay asset to receive post trade in position units
* **_tradeAdapterName**         Name of trade adapter
* **_tradeData**                Arbitrary data for trade

#### autoLever
AUTHORIZED CALLER (BOT) ONLY: Increases leverage for a given base (collateral) token using an enabled borrow asset (e.g. usdc in bull case). Borrows _borrowAsset from Aave. Performs a DEX trade, exchanging the _borrowAsset for _collateralAsset. Deposits _collateralAsset to Aave and mints corresponding aToken.

Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this on Initialize.

```
function autoLever(
    ISetToken _setToken,
    IERC20 _borrowAsset,
    IERC20 _collateralAsset,
    uint256 _borrowQuantityUnits,
    uint256 _minReceiveQuantityUnits,
    string memory _tradeAdapterName,
    bytes memory _tradeData
) external
```

* **_setToken**                     Instance of the SetToken
* **_borrowAsset**                  Address of underlying asset being borrowed for leverage
* **_collateralAsset**              Address of underlying collateral asset
* **_borrowQuantityUnits**          Borrow quantity of asset in position units
* **_minReceiveQuantityUnits**      Min receive quantity of collateral asset to receive post-trade in position units
* **_tradeAdapterName**             Name of trade adapter
* **_tradeData**                    Arbitrary data for trade

#### autoLever
AUTHORIZED CALLER (BOT) ONLY: Decrease leverage for a given collateral (base) token using an enabled borrow asset.
Withdraws _collateralAsset from Aave. Performs a DEX trade, exchanging the _collateralAsset for _repayAsset 
(i.e. borrowAsset). Repays _repayAsset to Aave and decreases leverage of index accordingly.
Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this
on initialize.

Note: This is CRITICAL to be called if position health factor becomes low.

```    
function autoDelever(
    ISetToken _setToken,
    IERC20 _collateralAsset,
    IERC20 _repayAsset,
    uint256 _redeemQuantityUnits,
    uint256 _minRepayQuantityUnits,
    string memory _tradeAdapterName,
    bytes memory _tradeData
)    external 
```

* **_setToken**                 Instance of the SetToken
* **_collateralAsset**          Address of underlying collateral asset being withdrawn
* **_repayAsset**               Address of underlying borrowed asset being repaid
* **_redeemQuantityUnits**      Quantity of collateral asset to delever in position units
* **_minRepayQuantityUnits**    Minimum amount of repay asset to receive post trade in position units
* **_tradeAdapterName**         Name of trade adapter
* **_tradeData**                Arbitrary data for trade

#### initialize
MANAGER ONLY: Initializes this module to the SetToken. Either the SetToken needs to be on the allowed list or anySetAllowed needs to be true. Only callable by the SetToken's manager.

Note: Managers can enable collateral and borrow assets that don't exist as positions on the SetToken

```    
function initialize(
    ISetToken _setToken,
    IERC20 _collateralAssets,
    IERC20 _borrowAssets
) external
```


* **_setToken**             Instance of the SetToken to initialize
* **_collateralAssets**     Underlying tokens to be enabled as collateral in the SetToken
* **_borrowAssets**         Underlying tokens to be enabled as borrow in the SetToken

#### registerToModule
MANAGER ONLY: Add registration of this module on the debt issuance module for the SetToken. 

Note: if the debt issuance module is not added to SetToken before this module is initialized, then this function
needs to be called if the debt issuance module is later added and initialized to prevent state inconsistencies

```
function registerToModule(ISetToken _setToken, IDebtIssuanceModule _debtIssuanceModule) external
```

* **_setToken**             Instance of the SetToken
* **_debtIssuanceModule**   Debt issuance module address to register

#### updateAllowedSetToken
GOVERNANCE ONLY: Enable/disable ability of a SetToken to initialize this module. Only callable by governance.
    
```
function updateAllowedSetToken(ISetToken _setToken, bool _status) external 
```

* **_setToken**             Instance of the SetToken
* **_status**               Bool indicating if _setToken is allowed to initialize this module


#### updateAnySetAllowed
GOVERNANCE ONLY: Toggle whether ANY SetToken is allowed to initialize this module. Only callable by governance.


```    
function updateAnySetAllowed(bool _anySetAllowed) external
```

* **_anySetAllowed**             Bool indicating if ANY SetToken is allowed to initialize this module
