/*
    Copyright 2022 Index Tech Ltd.

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
pragma experimental "ABIEncoderV2";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import { DebtIssuanceModule } from "@setprotocol/set-protocol-v2/contracts/protocol/modules/DebtIssuanceModule.sol";
import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import { Invoke } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Invoke.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IssuanceValidationUtils } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/IssuanceValidationUtils.sol";
import { Position } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Position.sol";
import { PreciseUnitMath } from "@setprotocol/set-protocol-v2/contracts/lib/PreciseUnitMath.sol";
import { ILendingPool } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/ILendingPool.sol";
import { ILendingPoolAddressesProvider } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/ILendingPoolAddressesProvider.sol";
import { IAToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/IAToken.sol";
import { IExchangeAdapter } from "@setprotocol/set-protocol-v2/contracts/interfaces/IExchangeAdapter.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";

import { console } from "hardhat/console.sol";


interface IPriceOracleGetter {
    function getAssetPrice(address _asset) external view returns (uint256);
    function getAssetsPrices(address[] calldata _assets) external view returns(uint256[] memory);
    function getSourceOfAsset(address _asset) external view returns(address);
    function getFallbackOracle() external view returns(address);
}

interface ILev3xAaveLeverageModule {
    function getIssuingMultiplier () 
    external 
    view 
    returns (uint256 _multiplier, uint256 _price);
}

/**
 * @title Lev3xIssuanceModule
 * @author IndexZoo
 *
 * The Lev3xIssuanceModule is a module that enables users to issue and redeem SetTokens that contain default and all
 * external positions, including debt positions. Module hooks are added to allow for syncing of positions, and component
 * level hooks are added to ensure positions are replicated correctly. The manager can define arbitrary issuance logic
 * in the manager hook, as well as specify issue and redeem fees.
 * 
 * NOTE: 
 * Lev3xIssuanceModule contract confirms increase/decrease in balance of component held by the SetToken after every transfer in/out
 * for each component during issuance/redemption. This contract replaces those strict checks with slightly looser checks which 
 * ensure that the SetToken remains collateralized after every transfer in/out for each component during issuance/redemption.
 * This module should be used to issue/redeem SetToken whose one or more components return a balance value with +/-1 wei error.
 * For example, this module can be used to issue/redeem SetTokens which has one or more aTokens as its components.
 * The new checks do NOT apply to any transfers that are part of an external position. A token that has rounding issues may lead to 
 * reverts if it is included as an external position unless explicitly allowed in a module hook.
 *
 * The getRequiredComponentIssuanceUnits function on this module assumes that Default token balances will be synced on every issuance
 * and redemption. If token balances are not being synced it will over-estimate the amount of tokens required to issue a Set.
 */
contract Lev3xIssuanceModule is DebtIssuanceModule {
    using Position for uint256;
    using PreciseUnitMath for int256;

    uint256 constant private price0 = 100 ether;
    uint256 constant public LTV_MARGIN = 0.05 ether;  // if ltv=80% then with margin 85%
    ILendingPoolAddressesProvider public lendingPoolAddressesProvider;
    ILendingPool public lender;
    
    /* ============ Constructor ============ */
    
    constructor(IController _controller, ILendingPoolAddressesProvider _lendingPoolAddressesProvider) public DebtIssuanceModule(_controller) {
        lendingPoolAddressesProvider = _lendingPoolAddressesProvider;
        lender = ILendingPool(lendingPoolAddressesProvider.getLendingPool());
    }

    // TODO: NB: componentRedeemHook of AaveLeverageModule is only called on resolveDebtPositions

    /**
     * Deposits components to the SetToken, replicates any external module component positions and mints 
     * the SetToken. If the token has a debt position all collateral will be transferred in first then debt
     * will be returned to the minting address. If specified, a fee will be charged on issuance.
     *     
     * NOTE: Overrides DebtIssuanceModule#issue external function and adds undercollateralization checks in place of the
     * previous default strict balances checks. The undercollateralization checks are implemented in IssuanceValidationUtils library and they 
     * revert upon undercollateralization of the SetToken post component transfer.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Quantity of SetToken to issue
     * @param _to               Address to mint SetToken to
     */
    function issue(
        ISetToken _setToken,
        uint256 _quantity,
        address _to
    )
        external
        override
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        require(_quantity > 0, "Issue quantity must be > 0");

        address hookContract = _callManagerPreIssueHooks(_setToken, _quantity, msg.sender, _to);

        _callModulePreIssueHooks(_setToken, _quantity);

        
        uint256 initialSetSupply = _setToken.totalSupply();

        (
            uint256 quantityWithFees,
            uint256 managerFee,
            uint256 protocolFee
        ) = calculateTotalFees(_setToken, _quantity, true);

        // Prevent stack too deep
        {       
            (
                address[] memory components,
                uint256[] memory equityUnits,
                uint256[] memory debtUnits
            ) = _calculateRequiredComponentIssuanceUnitsV2(_setToken, quantityWithFees, true);

            uint256 finalSetSupply = initialSetSupply.add(quantityWithFees);

            // TODO: sync()  -- if needed ?
            _resolveEquityPositions(_setToken, quantityWithFees, _to, true, components, equityUnits, initialSetSupply, finalSetSupply);
            _resolveDebtPositions(_setToken, quantityWithFees, true, components, debtUnits, initialSetSupply, finalSetSupply);
            _resolveFees(_setToken, managerFee, protocolFee);
            //TODO sync()
        }
        
        _setToken.mint(_to, _quantity);

        emit SetTokenIssued(
            _setToken,
            msg.sender,
            _to,
            hookContract,
            _quantity,
            managerFee,
            protocolFee
        );
    }

    /**
     * Returns components from the SetToken, unwinds any external module component positions and burns the SetToken.
     * If the token has debt positions, the module transfers in the required debt amounts from the caller and uses
     * those funds to repay the debts on behalf of the SetToken. All debt will be paid down first then equity positions
     * will be returned to the minting address. If specified, a fee will be charged on redeem.
     *
     * @param _setToken         Instance of the SetToken to redeem
     * @param _quantity         Quantity of SetToken to redeem
     * @param _to               Address to send collateral to
     */
    function redeem(
        ISetToken _setToken,
        uint256 _quantity,
        address _to
    )
        external
        override
        virtual        
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        require(_quantity > 0, "Redeem quantity must be > 0");
        require(_setToken.totalSupply() > 0, "No supply of set to redeem");

        _callModulePreRedeemHooks(_setToken, _quantity);

        uint256 initialSetSupply = _setToken.totalSupply();

        (
            uint256 quantityNetFees,
            uint256 managerFee,
            uint256 protocolFee
        ) = calculateTotalFees(_setToken, _quantity, false);

        // Prevent stack too deep
        {
            (
                address[] memory components,
                uint256[] memory equityUnits,
                uint256[] memory debtUnits
            ) = _calculateRequiredComponentIssuanceUnitsV2(_setToken, quantityNetFees, false);

            uint256 finalSetSupply = initialSetSupply.sub(quantityNetFees);

            _resolveLeverageState(_setToken, quantityNetFees, false, components, equityUnits );
            // Place burn after pre-redeem hooks because burning tokens may lead to false accounting of synced positions
            _setToken.burn(msg.sender, _quantity);

            // TODO: sync()
            _resolveDebtPositions(_setToken, quantityNetFees, false, components, debtUnits, initialSetSupply, finalSetSupply);
            _resolveEquityPositions(_setToken, quantityNetFees, _to, false, components, equityUnits, initialSetSupply, finalSetSupply);
            _resolveFees(_setToken, managerFee, protocolFee);
            // TODO sync()
            // TODO: convert redeemed aToken to token
        }

        emit SetTokenRedeemed(
            _setToken,
            msg.sender,
            _to,
            _quantity,
            managerFee,
            protocolFee
        );
    }

    /* ============ Internal Functions ============ */

    /**
     */
    function _resolveLeverageState (
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _equityUnits
    )
    internal
    {
        // address[] memory externalPositionModules = _setToken.getExternalPositionModules(address(_components[0]));
        // uint256 modulesLength = externalPositionModules.length;
        _executeExternalPositionHooks(_setToken, _quantity, IERC20(_components[0]), _isIssue, false);
    }

    /**
     * Resolve equity positions associated with SetToken. On issuance, the total equity position for an asset (including default and external
     * positions) is transferred in. Then any external position hooks are called to transfer the external positions to their necessary place.
     * On redemption all external positions are recalled by the external position hook, then those position plus any default position are
     * transferred back to the _to address.
     */
    function _resolveEquityPositions(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentEquityQuantities,
        uint256 _initialSetSupply,
        uint256 _finalSetSupply
    )
        internal
    {
        if(_isIssue)  _preDepositComponents(
            _components, 
            _componentEquityQuantities
        );
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentEquityQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    // Non-intuitive !! but AToken required this line 
                    IERC20(IAToken(component)).approve(address(this), componentQuantity);

                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        address(this),
                        address(_setToken),
                        componentQuantity
                    );

                    IssuanceValidationUtils.validateCollateralizationPostTransferInPreHook(_setToken, component, _initialSetSupply, componentQuantity);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, true);
                } else {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, true);

                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer
                    // console.log("componentQ"); console.log(componentQuantity);
                    // console.log("balance"); console.log(IERC20(component).balanceOf(address(_setToken)));
                    // FIXME: TODO: TODO: Investigate and fix problem not withdrawing full amount after winning/losing
                    // _rescaleUnits
                    // IAToken(component)
                    // require(componentQuantity <= IERC20(component).balanceOf(address(_setToken)), 
                    // "excess redeem amount at current state");
                    _componentEquityQuantities[i] = _validateComponentLastTransfer(_setToken, component, componentQuantity);
                    _setToken.invokeTransfer(component, address(this), _componentEquityQuantities[i]);

                    IssuanceValidationUtils.validateCollateralizationPostTransferOut(_setToken, component, _finalSetSupply);
                }
            }
        }
        if(!_isIssue) _postRedeemComponents(_components, _componentEquityQuantities, _to);
    }

    function _preDepositComponents(
        address[] memory _components,
        uint256[] memory _componentEquityQuantities
    )
    internal
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentEquityQuantities[i];
            if (componentQuantity > 0) {
                    address underlyingAsset = IAToken(component).UNDERLYING_ASSET_ADDRESS();
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(underlyingAsset),
                        msg.sender,
                        address(this),
                        componentQuantity
                    );
                    uint256 aTokenInitBalance = IAToken(component).balanceOf(address(this));
                    IERC20(underlyingAsset).approve(address(lender), componentQuantity);
                    lender.deposit(underlyingAsset, componentQuantity, address(this), 0);
                    uint256 aTokenFinalBalance = IAToken(component).balanceOf(address(this));
                    require(
                        aTokenFinalBalance.sub(aTokenInitBalance) >= componentQuantity, 
                        "issue: Deposit Failed"
                    );
            }
        }
    }
    /**
     * Utilizing multiple delevers in one txn might output a miscalculation with getIssuanceUnits
     * The miscalculation was probed to be about 2.6e-6 from _componentQuantity
     * i.e. 7033077306495252 > 7033059808425723
     */
    function _validateComponentLastTransfer(
        ISetToken _setToken,
        address _component,
        uint256 _componentQuantity
    )
    private
    view
    returns (uint256 _componentTransferrableQuantity)
    {
        uint256 setTokenComponentBalance = IERC20(_component).balanceOf(address(_setToken));
        require(setTokenComponentBalance.preciseMul(1.01 ether) >= _componentQuantity, "");
        _componentTransferrableQuantity = setTokenComponentBalance >= _componentQuantity?
                        _componentQuantity:
                        setTokenComponentBalance;
    }

    function _postRedeemComponents(
        address[] memory _components,
        uint256[] memory _componentEquityQuantities,
        address _to
    )
    internal
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentEquityQuantities[i];
            if (componentQuantity > 0) {
                address underlyingAsset = IAToken(component).UNDERLYING_ASSET_ADDRESS();
                // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                uint256 tokenInitBalance = IERC20(underlyingAsset).balanceOf(_to);
                lender.withdraw(underlyingAsset, componentQuantity, _to);
                uint256 tokenFinalBalance = IERC20(underlyingAsset).balanceOf(_to);
                require(
                    tokenFinalBalance.sub(tokenInitBalance) >= componentQuantity, 
                    "redeem: Withdraw Failed"
                );
            }
        }
    }


    /**
     * Resolve debt positions associated with SetToken. On issuance, debt positions are entered into by calling the external position hook. The
     * resulting debt is then returned to the calling address. On redemption, the module transfers in the required debt amount from the caller
     * and uses those funds to repay the debt on behalf of the SetToken.
     */
    function _resolveDebtPositions(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentDebtQuantities,
        uint256 _initialSetSupply,
        uint256 _finalSetSupply
    )
        internal
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentDebtQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, false);
                    
                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer
                    _setToken.invokeTransfer(component, msg.sender, componentQuantity);

                    IssuanceValidationUtils.validateCollateralizationPostTransferOut(_setToken, component, _finalSetSupply);
                } else {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        componentQuantity
                    );

                    IssuanceValidationUtils.validateCollateralizationPostTransferInPreHook(_setToken, component, _initialSetSupply, componentQuantity);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, false);
                }
            }
        }
    }


        /**
        * Calculates the amount of each component needed to collateralize passed issue quantity of Sets as well as amount of debt that will
        * be returned to caller. Can also be used to determine how much collateral will be returned on redemption as well as how much debt
        * needs to be paid down to redeem.
        *
        * @param _setToken         Instance of the SetToken to issue
        * @param _quantity         Amount of Sets to be issued/redeemed
        * @param _isIssue          Whether Sets are being issued or redeemed
        *
        * @return address[]        Array of component addresses making up the Set
        * @return uint256[]        Array of equity notional amounts of each component, respectively, represented as uint256
        * @return uint256[]        Array of debt notional amounts of each component, respectively, represented as uint256
        */
        function _calculateRequiredComponentIssuanceUnitsV2(
            ISetToken _setToken,
            uint256 _quantity,
            bool _isIssue
        )
            internal
            view
            returns (address[] memory, uint256[] memory, uint256[] memory)
        {
            (
                address _components,
                uint256 equityUnits,
                uint256 debtUnits
            ) = _getTotalIssuanceUnitsV2(_setToken, _isIssue);

            address[] memory components = new address[](1);
            components[0] = (_components);

            uint256 componentsLength = 1;
            uint256[] memory totalEquityUnits = new uint256[](componentsLength);
            uint256[] memory totalDebtUnits = new uint256[](componentsLength);
            for (uint256 i = 0; i < componentsLength; i++) {
                // Use preciseMulCeil to round up to ensure overcollateration when small issue quantities are provided
                // and preciseMul to round down to ensure overcollateration when small redeem quantities are provided
                totalEquityUnits[i] = _isIssue ?
                    equityUnits.preciseMulCeil(_quantity) :
                    equityUnits.preciseMul(_quantity);

                totalDebtUnits[i] = _isIssue ?
                    debtUnits.preciseMul(_quantity) :
                    debtUnits.preciseMulCeil(_quantity);
            }

            return (components, totalEquityUnits, totalDebtUnits);
        }

        /**
        * Sums total debt and equity units for each component, taking into account default and external positions.
        *
        * @param _setToken         Instance of the SetToken to issue
        *
        * @return address[]        Array of component addresses making up the Set
        * @return uint256[]        Array of equity unit amounts of each component, respectively, represented as uint256
        * @return uint256[]        Array of debt unit amounts of each component, respectively, represented as uint256
        */
        function _getTotalIssuanceUnitsV2(
            ISetToken _setToken,
            bool _isIssue
        )
            internal
            view
            returns (address , uint256 , uint256 )
        {
            address[] memory components = _setToken.getComponents();
            uint256 setTotalSupply = _setToken.totalSupply();

            // if (setTotalSupply == 0) 
            // {
            //     // TODO: find proper factor to multiply by
            // (
            //     uint256 totalCollateralETH, 
            //     uint256 totalDebtETH,
            // ,,,) = lender.getUserAccountData(address(_setToken)); 

            //     return (
            //         components[0], 
            //         _setToken.getDefaultPositionRealUnit(components[0]).toUint256(),
            //         0
            //     );
            // }

            // NOTE: This should be 1.8 ether -- zToken.getPostions() showing that
            // uint256 cumulativeEquity = _setToken.getDefaultPositionRealUnit(components[0]).toUint256();   // starts by the base component of setToken
            uint256 cumulativeEquity ; 
            uint256 cumulativeDebt;
            (
                uint256 totalCollateralETH, 
                uint256 totalDebtETH,
            ,,,) = lender.getUserAccountData(address(_setToken)); 
            // console.log("collateral");
            // console.log(totalCollateralETH);
            // console.log(totalDebtETH);

            // TODO: TODO: consider the successive delever loss due to swap
            // uint256 unitCollateralETH = _isIssue? totalCollateralETH.preciseDivCeil(setTotalSupply):
            //                               totalCollateralETH.preciseDiv(setTotalSupply);
            // uint256 unitDebtETH = _isIssue? totalDebtETH.preciseDiv(setTotalSupply):
            //                         totalDebtETH.preciseDivCeil(setTotalSupply);
            uint256 factor = _calcFactor(_setToken, totalCollateralETH, totalDebtETH, components);

                 

            uint256 unitCollateralETH = _isIssue? factor.preciseMulCeil(_setToken.getDefaultPositionRealUnit(components[0]).toUint256()):
                                          totalCollateralETH.preciseDiv(setTotalSupply);
            // getAmountsIn(totalDebtETH*oraclePrice) / setTotalSupply
            totalDebtETH = _transformDebt(_setToken, components, totalDebtETH);  
            uint256 unitDebtETH = _isIssue? 0:
                                    totalDebtETH.preciseDivCeil(setTotalSupply);
            
            // uint256 swapFactor;
            // if(!_isIssue) {
            //     swapFactor = _calcSwapFactor(_setToken);
            // }
            // console.log("swapFactor"); console.log(swapFactor);
            // uint256 swapFactor = 0.99 ether;

             // TODO: might need swapFactor in issue
            // cumulativeEquity = _isIssue || swapFactor == 0? unitCollateralETH.sub(unitDebtETH): 
            //                         unitCollateralETH.sub(unitDebtETH.preciseDivCeil(swapFactor));
            cumulativeEquity =  unitCollateralETH.sub(unitDebtETH);

            cumulativeDebt = 0;
            return (components[0], cumulativeEquity, cumulativeDebt);
        }

    function _calcFactor(
        ISetToken _setToken,
        uint256 totalCollateralETH,
        uint256 totalDebtETH,
        address[] memory _components
    )
    private
    view
    returns (uint256 )
    {
        ILev3xAaveLeverageModule  levModule =  ILev3xAaveLeverageModule(_setToken.getExternalPositionModules(_components[0])[0]);
        (
            uint256 factor,
        ) = levModule.getIssuingMultiplier();
        return factor;
        // IPriceOracleGetter priceOracle = IPriceOracleGetter(lendingPoolAddressesProvider.getPriceOracle());
        // uint256 invPrice;
        // uint256 factor;
        // if(totalDebtETH != 0) {
        //     uint256 leverage = totalCollateralETH.preciseDivCeil(totalCollateralETH.sub(totalDebtETH))  ;
        //     invPrice = priceOracle.getAssetPrice(components[1]);
        //     factor = leverage.preciseMulCeil(PreciseUnitMath.PRECISE_UNIT.sub(price0.preciseMul(invPrice))).add(price0.preciseMulCeil(invPrice));
        // } else {
        //     factor = PreciseUnitMath.PRECISE_UNIT;
        // }
        // return factor;
    }

    function _calcSwapFactor(
        ISetToken _setToken
    )
    private
    view
    returns (uint256 swapFactor)
    {
        address[] memory components = _setToken.getComponents();
        address collateralAsset = IAToken(components[0]).UNDERLYING_ASSET_ADDRESS();
        swapFactor=  components.length==1? 1 ether:
            preciseSqrt(_getSwapAmountOut(
                _getSwapAmountOut(
                    1 ether,  // 
                    collateralAsset,
                    address(components[1] )
                ),
                address(components[1] ),
                collateralAsset
            ));
    }

    function _transformDebt(
        ISetToken _setToken,
        address[] memory _components,
        uint256 _totalDebtETH
    )
    private
    view
    returns (uint256 _debt)
    {
        if(_totalDebtETH == 0) return 0;
        IPriceOracleGetter priceOracle = IPriceOracleGetter(lendingPoolAddressesProvider.getPriceOracle());
        uint256 absDebt = _totalDebtETH.preciseDivCeil(priceOracle.getAssetPrice(_components[1]));
        _debt = _getSwapAmountIn(absDebt, IAToken(_components[0]).UNDERLYING_ASSET_ADDRESS(), _components[1]);
    }

    
    function _accumulateExternalPositions(
        ISetToken _setToken,
        address _component 
    )
    internal
    view
    returns (uint256 cumulativeEquity, uint256 cumulativeDebt) {
        IPriceOracleGetter priceOracle = IPriceOracleGetter(lendingPoolAddressesProvider.getPriceOracle());
        int256 price = priceOracle.getAssetPrice(_component).toInt256();
                address[] memory externalPositions = _setToken.getExternalPositionModules(_component);
                if (externalPositions.length > 0) {
                    for (uint256 j = 0; j < externalPositions.length; j++) { 
                        int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(_component, externalPositions[j]).preciseMul(price);

                        // If positionUnit <= 0 it will be "added" to debt position
                        if (externalPositionUnit > 0) {
                            cumulativeEquity = cumulativeEquity.add(externalPositionUnit.toUint256());
                        } else {
                            cumulativeDebt = cumulativeDebt.add(externalPositionUnit.mul(-1).toUint256());
                        }
                    }
                }
    }
 
     /* ========================== Others =========================*/
    // TODO: Move these funcs to library
    function _getSwapAmountOut(
        uint256 _amountIn,
        address _assetIn,
        address _assetOut
    )
    private
    view
    returns (uint256 _amountOut)
    {
        address [] memory path = new address[](2);
        path[0] = _assetIn; 
        path[1] = _assetOut;
        _amountOut = IUniswapV2Router(
            IExchangeAdapter(getAndValidateAdapter("UNISWAP")).getSpender()
        ).getAmountsOut(_amountIn, path)[1];  // 
    }  

    function _getSwapAmountIn (
        uint256 _amountOut,
        address _assetIn,
        address _assetOut
    )
    private
    view
    returns (uint256 _amountIn)
    {
        address [] memory path = new address[](2);
        path[0] = _assetIn; 
        path[1] = _assetOut;
        _amountIn = IUniswapV2Router(
            IExchangeAdapter(getAndValidateAdapter("UNISWAP")).getSpender()
        ).getAmountsIn(_amountOut, path)[0];  // 
    }  

    function preciseSqrt(uint y) internal pure returns (uint z) {
        z = _sqrt(y).preciseDiv(10**9);

    }

    function _sqrt(uint y) internal pure returns (uint z) {
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