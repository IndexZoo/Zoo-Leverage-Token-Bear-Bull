/*
    Copyright 2022 IndexTech Ltd.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { PreciseUnitMath } from "@setprotocol/set-protocol-v2/contracts/lib/PreciseUnitMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { IExchangeAdapterV3} from "../interfaces/IExchangeAdapterV3.sol";
import { Position } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Position.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ILev3xAaveLeverageModule } from "../interfaces/ILev3xAaveLeverageModule.sol";
import { IPriceOracleGetter } from "../interfaces/IPriceOracleGetter.sol";
import { IProtocolDataProvider } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/IProtocolDataProvider.sol";
import { ILendingPool } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/ILendingPool.sol";
import { ILendingPoolAddressesProvider } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/ILendingPoolAddressesProvider.sol";
import { IVariableDebtToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/IVariableDebtToken.sol";
import { IAToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/IAToken.sol";
import {console} from "hardhat/console.sol";

/**
 * @title IndexUtils 
 * @author IndexZoo 
 *
 *
 */
library IndexUtils {
    using SafeMath for uint256;
    using SignedSafeMath for int256;
    using Position for ISetToken;
    using Address for address;
    using PreciseUnitMath for uint256;

    enum AssetType {
        COLLATERAL,
        BORROW 
    }

    /* =========== SetToken ========== */

    function calculateIssuingFactor(
        ISetToken _setToken
    )
    external 
    view
    returns (uint256 )
    {
        address component = _setToken.getComponents()[0];
        address[] memory externalModules = _setToken.getExternalPositionModules(component);
        ILev3xAaveLeverageModule  levModule =  ILev3xAaveLeverageModule(externalModules[0]);
        (
            uint256 factor,
        ) = levModule.getIssuingMultiplier(_setToken);
        return factor;
    }

    function assetPriceInETH(
        ISetToken _setToken,
        ILendingPoolAddressesProvider _lendingPoolAddressesProvider,
        AssetType _assetType
    )
    public 
    view 
    returns (uint256 _assetPrice)
    {
        address[] memory components = _setToken.getComponents();
        require( _assetType == AssetType.COLLATERAL || components.length == 2, "Redemption not yet allowed");
        IPriceOracleGetter priceOracle = IPriceOracleGetter(_lendingPoolAddressesProvider.getPriceOracle());
        address asset;
        if(_assetType == AssetType.COLLATERAL) {
            asset = IAToken(components[0]).UNDERLYING_ASSET_ADDRESS();
        } else {
            asset = components[1];
        }
        _assetPrice = priceOracle.getAssetPrice(asset) ;
    }

    function calculateDebtWithSwapFees(
        ISetToken _setToken,
        ILendingPoolAddressesProvider _lendingPoolAddressesProvider,
        IUniswapV2Router _router,
        uint256 _totalDebtETH
    )
    external 
    view
    returns (uint256 _debt)
    {
        address[] memory components = _setToken.getComponents();
        if(_totalDebtETH == 0) return 0;
        require(components.length >= 2, "Redemption not yet allowed");
        IPriceOracleGetter priceOracle = IPriceOracleGetter(_lendingPoolAddressesProvider.getPriceOracle());
        uint256 absDebt = _totalDebtETH
                    .preciseDivCeil(priceOracle.getAssetPrice(components[1]))
                    .preciseMul(getUnitOf(IERC20(components[1])));
        
        // debt calculated in Collateral 
        _debt = getSwapAmountIn(
            _router,
            absDebt, 
            IAToken(components[0]).UNDERLYING_ASSET_ADDRESS(), 
            components[1]
        );
    }

    /**
     * Function works along side delevering process as it aims to get the amount allowable to be 
     * repaid for Aave in order to proceed other tasks.
     * Note that repayAmount is equal to the withdrawable amount if leverage is greater than
     * (1 + ltv). In that case, it is likely needed to execute multiple consecutive withdrawals.
     * Otherwise repayAmount is the debt of setToken to Aave.
     * @param _setToken                          instance of SetToken to execute calcs on
     * @param _lendingPoolAddressesProvider      lending Protocol
     * @param _router                            Uniswap Router
     * @param _repayAsset                        The asset incurring debt on _setToken to Aave
     * @param _setTokenQuantity                  Quantity of setToken to be redeemed
     */

    function calculateRepayAllowances(
        ISetToken _setToken,
        ILendingPoolAddressesProvider _lendingPoolAddressesProvider,
        IUniswapV2Router _router,
        address _repayAsset,
        uint256 _setTokenQuantity
    )
    external 
    view
    returns (uint256 _repayAmount, uint256 _withdrawable, uint256 _totalDebtETH) 
    {
        // uint256 _units;
        uint256 totalCollateralETH;
        address collateralAsset = _setToken.getComponents()[0];
        uint256 ltv; 

        (
            totalCollateralETH, 
            _totalDebtETH,
            ,, ltv,
        ) = ILendingPool(_lendingPoolAddressesProvider.getLendingPool()).getUserAccountData(address(_setToken));
        
        // units redeemed according to collateral/debt proportion
        // updating units because the deviation between dex & oracle prices might cause increase for (c - d) which is anamolous
        // _units = (totalCollateralETH.sub(_totalDebtETH)).preciseDivCeil(_setToken.totalSupply()).preciseMulCeil(_setTokenQuantity);
        // _units = _units.preciseDivCeil(_setToken.totalSupply());   // 
        
        if(_totalDebtETH == 0)  return (0, totalCollateralETH, 0);

        uint256 debtInBorrowAsset = getDebtAmount(_lendingPoolAddressesProvider, address(_setToken), _repayAsset); 
        ltv = 1 ether * ltv / 10000;
        // position HF < 1, hence cannot withdraw, (typically portion will be liquidated) 
        require(totalCollateralETH  >=_totalDebtETH.preciseDivCeil(ltv), "Position needs funding" );
        _withdrawable = (totalCollateralETH - (_totalDebtETH.preciseDivCeil(ltv))).preciseDiv(_setToken.totalSupply());
        _withdrawable = _withdrawable.preciseDiv(
            assetPriceInETH(_setToken, _lendingPoolAddressesProvider, AssetType.COLLATERAL)
        );
        _withdrawable = _withdrawable.preciseMul(getUnitOf(IERC20(collateralAsset)));       



        _totalDebtETH =  getSwapAmountIn(
            _router,
            debtInBorrowAsset,
            IAToken(collateralAsset).UNDERLYING_ASSET_ADDRESS(),
            _repayAsset 
        ); 

        _repayAmount = _totalDebtETH.preciseDiv(_setToken.totalSupply()) >= _withdrawable? _withdrawable:_totalDebtETH.preciseDivCeil(_setToken.totalSupply());
    }

    function calculateRedeemUnits(
        ISetToken _setToken,
        ILendingPoolAddressesProvider _lendingPoolAddressesProvider,
        uint256 _setTokenQuantity
    )
    external 
    view
    returns (uint256 _units) 
    {
        (
            uint256 totalCollateralETH, 
            uint256 totalDebtETH,
            ,,,
        ) = ILendingPool(_lendingPoolAddressesProvider.getLendingPool()).getUserAccountData(address(_setToken));
        
        // units redeemed according to collateral/debt proportion
        // updating units because the deviation between dex & oracle prices might cause increase for (c - d) which is anamolous
        _units = (totalCollateralETH.sub(totalDebtETH)).preciseDivCeil(_setToken.totalSupply()).preciseMulCeil(_setTokenQuantity);
        _units = _units.preciseDivCeil(_setToken.totalSupply());   // 
    }

    /* ========== Lending Protocol ========= */
    function getDebtAmount(
        ILendingPoolAddressesProvider _lendingPoolAddressesProvider,
        address _holder,
        address _asset
    )
    public
    view
    returns (uint256 _amount)
    {
        IProtocolDataProvider protocolDataProvider = IProtocolDataProvider(
        // Use the raw input vs bytes32() conversion. This is to ensure the input is an uint and not a string.
            _lendingPoolAddressesProvider.getAddress(0x0100000000000000000000000000000000000000000000000000000000000000)
        );
        (, , address variableDebtToken) = protocolDataProvider.getReserveTokensAddresses(_asset);
        _amount = IVariableDebtToken(variableDebtToken).balanceOf(_holder);       
    }
 


    /* =========== Uniswap Router ========== */

    function getSwapAmountOut(
        IUniswapV2Router _router,
        uint256 _amountIn,
        address _assetIn,
        address _assetOut
    )
    public 
    view
    returns (uint256 _amountOut)
    {
        address [] memory path = new address[](2);
        path[0] = _assetIn; 
        path[1] = _assetOut;
        _amountOut = _router.getAmountsOut(_amountIn, path)[1];  // 
    } 

    function getSwapAmountIn (
        IUniswapV2Router _router,
        uint256 _amountOut,
        address _assetIn,
        address _assetOut
    )
    public 
    view
    returns (uint256 _amountIn)
    {
        address [] memory path = new address[](2);
        path[0] = _assetIn; 
        path[1] = _assetOut;
        _amountIn = _router.getAmountsIn(_amountOut, path)[0];  // 
    }



    function invokeSwapExact(
        ISetToken _setToken,
        IExchangeAdapterV3 adapter,
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn,
        uint256 _amountOutMin
    )
       internal 
       returns (uint256[] memory amounts)
    {
        (
            address target,
            uint256 callValue,
            bytes memory methodData
        ) = adapter.getTradeCalldata(
            _tokenIn, 
            _tokenOut, 
            address(_setToken), 
            _amountIn, 
            _amountOutMin, 
            true,
            ""
        );
        bytes memory data = _setToken.invoke(target, callValue, methodData);
        amounts = abi.decode(data, (uint256[]));
    }

    function invokeSwapToIndex(
        ISetToken _setToken,
        IExchangeAdapterV3 adapter,
        address _tokenIn,
        address _tokenOut,
        uint256 _amountOut,
        uint256 _amountInMax
    )
       internal 
       returns (uint256[] memory amounts)
    {
        (
            address target,
            uint256 callValue,
            bytes memory methodData
        ) = adapter.getTradeCalldata(
            _tokenIn, 
            _tokenOut, 
            address(_setToken), 
            _amountOut, 
            _amountInMax, 
            false,
            ""
        );
        bytes memory data = _setToken.invoke(target, callValue, methodData);
        amounts = abi.decode(data, (uint256[]));
    }


    /*============= ERC20 ==============*/

    function getUnitOf(
        IERC20 _token
    )
    internal 
    view
    returns (uint256)
    {
        return 10**uint256(getDecimalsOf(address(_token)));
    }

    function getDecimalsOf (
        address _token
    )
    internal 
    view
    returns (uint8 )
    {
        bytes memory callData = abi.encodeWithSignature("decimals()");
        bytes memory data = _token.functionStaticCall(callData);
        return abi.decode(data, (uint8));
    }

    /*============= Maths ==============*/

    function preciseSqrt(uint y) external pure returns (uint z) {
        z = sqrt(y).preciseDiv(10**9);

    }

    function sqrt(uint y) public pure returns (uint z) {
        if (y > 3) {
            z = y;
            uint x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}