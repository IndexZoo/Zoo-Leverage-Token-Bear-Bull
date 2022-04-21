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
import { console } from "hardhat/console.sol";


interface IPriceOracleGetter {
    function getAssetPrice(address _asset) external view returns (uint256);
    function getAssetsPrices(address[] calldata _assets) external view returns(uint256[] memory);
    function getSourceOfAsset(address _asset) external view returns(address);
    function getFallbackOracle() external view returns(address);
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
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentEquityQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        componentQuantity
                    );

                    IssuanceValidationUtils.validateCollateralizationPostTransferInPreHook(_setToken, component, _initialSetSupply, componentQuantity);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, true);
                } else {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, true);

                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer

                    _setToken.invokeTransfer(component, _to, componentQuantity);

                    IssuanceValidationUtils.validateCollateralizationPostTransferOut(_setToken, component, _finalSetSupply);
                }
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
            if (setTotalSupply == 0) {
                return (
                    components[0], 
                    _setToken.getDefaultPositionRealUnit(components[0]).toUint256(),
                    0
                );
            }

            // NOTE: This should be 1.8 ether -- zToken.getPostions() showing that
            // uint256 cumulativeEquity = _setToken.getDefaultPositionRealUnit(components[0]).toUint256();   // starts by the base component of setToken
            uint256 cumulativeEquity ; 
            uint256 cumulativeDebt;
            (
                uint256 totalCollateralETH, 
                uint256 totalDebtETH,
            ,,,) = lender.getUserAccountData(address(_setToken)); 

            // for (uint256 i = 1; i < components.length; i++) {
            //     address component = components[i];
            //     // TODO: adjust issue and redeem logic according to sync()
            //     // TODO: work on formulation considering swap fees with delever

            //     (uint256 tEquity, uint256 tDebt) = _accumulateExternalPositions(_setToken, component);
            //     cumulativeEquity = cumulativeEquity.add(tEquity);
            //     cumulativeDebt = cumulativeDebt.add(tDebt);
            //     // cumulativeEquity = _isIssue? 
            //     //     _setToken.getDefaultPositionRealUnit(component).toUint256(): totalCollateralETH.preciseDiv(_setToken.totalSupply());


            //     // TODO: might not need Lev3xModuleIssuanceHook in that case
            //     // cumulativeDebt = _isIssue?0:totalDebtETH.preciseDivCeil(_setToken.totalSupply());
            // }
            // cumulativeEquity = cumulativeEquity.sub(cumulativeDebt);
            cumulativeEquity = totalCollateralETH.sub(totalDebtETH);
            cumulativeEquity = _isIssue? 
                           cumulativeEquity.preciseDivCeil(setTotalSupply):
                           cumulativeEquity.preciseDiv(setTotalSupply);
            cumulativeDebt = 0;
            return (components[0], cumulativeEquity, cumulativeDebt);
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
   
}