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
pragma experimental "ABIEncoderV2";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import { DebtIssuanceModule } from "./DebtIssuanceModule.sol";
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
import { IndexUtils } from "../lib/IndexUtils.sol";



/**
 * @title Lev3xIssuanceModule
 * @author IndexZoo
 *
 * The Lev3xIssuanceModule is a module that enables users to issue and redeem SetTokens that contain default and all
 * external positions, including debt positions. Module hooks are added to allow for syncing of positions, and component
 * level hooks are added to ensure positions are replicated correctly. 
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
 */
contract Lev3xIssuanceModule is DebtIssuanceModule {
    using Position for uint256;
    using PreciseUnitMath for int256;
    using IndexUtils for ISetToken;
    using IndexUtils for IUniswapV2Router;
    using IndexUtils for IERC20;

    string constant public UNISWAP_INTEGRATION = "UNISWAP";  // For uniswap-like dex
    uint256 constant public LTV_MARGIN = 0.05 ether;  // if ltv=80% then with margin it is 85%
    ILendingPoolAddressesProvider public lendingPoolAddressesProvider;
    
    /* ============ Constructor ============ */
    
    constructor(IController _controller, ILendingPoolAddressesProvider _lendingPoolAddressesProvider) public DebtIssuanceModule(_controller) {
        lendingPoolAddressesProvider = _lendingPoolAddressesProvider;
    }

    /**
     * Deposits stable asset (e.g. usdc) to the index and mints 
     * quantity of the index leverage token. Amount of asset to be received is proportional to quantity.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Quantity of SetToken to issue
     * @param _to               Address to mint SetToken to
     * @param _maxEquityCost    Slippage
     */
    function issue(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        uint256 _maxEquityCost
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

        // Prevent stack too deep
        {       
            (
                address component,
                uint256 equityUnit,
            ) = _calculateRequiredComponentIssuanceUnitsV2(_setToken, _quantity, true);

            uint256 finalSetSupply = initialSetSupply.add(_quantity);

            // Swap tokens for aTokens by depositing onto Lender
            _preIssueComponents(
                component, 
                equityUnit,
                _maxEquityCost
            );

            _resolveEquityPositions(_setToken, _quantity, _to, true, component, equityUnit, initialSetSupply, finalSetSupply);
        }
        
        _setToken.mint(_to, _quantity);

        emit SetTokenIssued(
            _setToken,
            msg.sender,
            _to,
            hookContract,
            _quantity,
            0,
            0
        );
    }

    /**
     * Returns components from the SetToken, unwinds any external module component positions and burns the SetToken.
     * If the token has debt positions, the module transfers the equity after deducting the debt amount for the user.
     * 
     * redeemed_equity_per_index = (collateral - debt) * quantity / index_total_supply
     * 
     * @param _setToken              Instance of the SetToken to redeem
     * @param _quantity              Quantity of SetToken to redeem
     * @param _to                    Address to send collateral to
     * @param _minEquityReceived     Slippage
     */
    function redeem(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        uint256 _minEquityReceived
    )
        external
        override
        virtual        
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        require(_quantity <= _setToken.balanceOf(msg.sender), "quantity exceeds balance");
        require(_quantity > 0, "Redeem quantity must be > 0");
        require(_setToken.totalSupply() > 0, "No supply of set to redeem");

        _callModulePreRedeemHooks(_setToken, _quantity);

        uint256 initialSetSupply = _setToken.totalSupply();

        // Prevent stack too deep
        {
            (
                address component,
                uint256 equityUnit,
            ) = _calculateRequiredComponentIssuanceUnitsV2(_setToken, _quantity, false);

            uint256 finalSetSupply = initialSetSupply.sub(_quantity);

            _resolveLeverageState(_setToken, _quantity, false, component);
            // Place burn after pre-redeem hooks because burning tokens may lead to false accounting of synced positions
            _setToken.burn(msg.sender, _quantity);

            uint256 redeemedQuantity = _resolveEquityPositions(_setToken, _quantity, _to, false, component, equityUnit, initialSetSupply, finalSetSupply);
            _postRedeemComponents(component, redeemedQuantity, _to, _minEquityReceived); 
        }

        emit SetTokenRedeemed(
            _setToken,
            msg.sender,
            _to,
            _quantity,
            0,
            0 
        );
    }

    /* =========== View Functions ================= */

    /**
    * Calculates the amount of collateral asset needed to collateralize passed issue quantity of Sets that will
    * be returned to caller. Can also be used to determine how much collateral will be returned on redemption. 
    * It calculates the total amount required of collateral asset for a given setToken quantity.
    *
    * @param _setToken         Instance of the SetToken to issue
    * @param _quantity         Amount of Sets to be issued/redeemed
    * @param _isIssue          Whether Sets are being issued or redeemed
    *
    * @return _equityCost      equity notional amounts of component, represented as uint256
    */
    function calculateEquityIssuanceCost(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue
    )
    external
    view
    returns (uint256 _equityCost)
    {
        (
            , _equityCost, 
        ) = _calculateRequiredComponentIssuanceUnitsV2(_setToken, _quantity, _isIssue);
    }

    /* ============ Internal Functions ============ */

    /**
     * Delever current state of setToken in order to provide enough redeemable quantity for the redeemer.
     * According to the quantity to be redeemed, setToken might need multiple delevers in order to provide
     * the redeemer the amount of collateral asset corresponding to the quantity being redeemed.
     *
     * The withdrawable quantity of collateral is : collateral - debt/ltv
     * If amount of collateral to be redeemed is bigger than withdrawable then delever again until you reach 
     * the target.
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Quantity of SetToken aimed to be redeemed
     * @param _isIssue          process if issue or redeem
     * @param _component        asset to be redeemed 
     */
    function _resolveLeverageState (
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue,
        address _component
    )
    internal
    {
        _executeExternalPositionHooks(_setToken, _quantity, IERC20(_component), _isIssue, false);
    }

    /**
     * Resolve equity positions associated with SetToken. On issuance, the total equity position 
     * for an asset is transferred in. 
     * It also resolves debt positions associated with SetToken. On issuance, debt positions are 
     * accounted for by a factor multiplied by the set quantity to be issued . On redemption, the 
     * module subtracts the required debt amount from the amount to be redeemed to caller and uses 
     * those funds to repay the debt on behalf of the SetToken.
     */
    function _resolveEquityPositions(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        bool _isIssue,
        address _component,
        uint256 _componentEquityQuantities,
        uint256 _initialSetSupply,
        uint256 _finalSetSupply
    )
        internal
        returns (uint256 )
    {
            uint256 componentQuantity = _componentEquityQuantities;
            if (componentQuantity > 0) {
                if (_isIssue) {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    // Non-intuitive !! but AToken required this line 
                    IERC20(IAToken(_component)).approve(address(this), componentQuantity);

                    SafeERC20.safeTransferFrom(
                        IERC20(_component),
                        address(this),
                        address(_setToken),
                        componentQuantity
                    );

                    // IssuanceValidationUtils.validateCollateralizationPostTransferInPreHook(_setToken, _component, _initialSetSupply, componentQuantity);
                } else {
                    componentQuantity = _validateComponentLastTransfer(_setToken, _component, componentQuantity);
                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer
                    _setToken.invokeTransfer(_component, address(this), componentQuantity);

                    // IssuanceValidationUtils.validateCollateralizationPostTransferOut(_setToken, _component, _finalSetSupply);
                }
            } 
            return componentQuantity;
    }
     
    /**
     * Since the setToken requires aToken in order to issue sets, module initiates 
     * the issuing process by depositing token to lending pool on behalf of issuer 
     * in order to receive corresponding aToken from which the Module issues the setToken.
     */
    function _preIssueComponents(
        address _component,
        uint256 _componentQuantity,
        uint256 _maxEquityCost
    )
    internal
    {
        require(_componentQuantity <= _maxEquityCost, "amount exceeded slippage");
        ILendingPool lender = ILendingPool(lendingPoolAddressesProvider.getLendingPool()); 
            if (_componentQuantity > 0) {
                    address underlyingAsset = IAToken(_component).UNDERLYING_ASSET_ADDRESS();
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(underlyingAsset),
                        msg.sender,
                        address(this),
                        _componentQuantity
                    );
                    uint256 aTokenInitBalance = IAToken(_component).balanceOf(address(this));
                    IERC20(underlyingAsset).approve(address(lender), _componentQuantity);
                    lender.deposit(underlyingAsset, _componentQuantity, address(this), 0);
                    uint256 aTokenFinalBalance = IAToken(_component).balanceOf(address(this));
                    require(
                        aTokenFinalBalance.sub(aTokenInitBalance) >= _componentQuantity, 
                        "issue: Deposit Failed"
                    );
            }
    }


    /**
     * Since the setToken requires aToken in order to issue sets, and consequently redeems
     * aTokens. Redeemer requires the underlying asset of aToken to be received. SetToken
     * withdraws the underlying asset from the lending protocol on behalf of the redeemer. 
     */
    function _postRedeemComponents(
        address _component,
        uint256 _componentQuantity,
        address _to,
        uint256 _minEquityReceived
    )
    internal
    {
        ILendingPool lender = ILendingPool(lendingPoolAddressesProvider.getLendingPool());  
            if (_componentQuantity > 0) {
                address underlyingAsset = IAToken(_component).UNDERLYING_ASSET_ADDRESS();
                // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                uint256 tokenInitBalance = IERC20(underlyingAsset).balanceOf(_to);
                lender.withdraw(underlyingAsset, _componentQuantity, _to);
                uint256 tokenFinalBalance = IERC20(underlyingAsset).balanceOf(_to);
                require(
                    tokenFinalBalance.sub(tokenInitBalance) >= _minEquityReceived,
                    "amount less than slippage" 
                );
                require(
                    tokenFinalBalance.sub(tokenInitBalance) >= _componentQuantity, 
                    "redeem: Withdraw Failed"
                );
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
    * @return address       component addresses making up the Set
    * @return uint256       equity notional amounts of component, represented as uint256
    * @return uint256       debt notional amounts of component, represented as uint256
    */
    function _calculateRequiredComponentIssuanceUnitsV2(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue
    )
    internal
    view
    returns (address , uint256 , uint256 )
    {
        (
            address component,
            uint256 equityUnit,
            uint256 debtUnit
        ) = _getTotalIssuanceUnitsV2(_setToken, _isIssue);

        uint256 totalEquityUnit; 
        uint256 totalDebtUnit ;
        // Use preciseMulCeil to round up to ensure overcollateration when small issue quantities are provided
        // and preciseMul to round down to ensure overcollateration when small redeem quantities are provided
        totalEquityUnit = _isIssue ?
                equityUnit.preciseMulCeil(_quantity) :
                equityUnit.preciseMul(_quantity);
        totalDebtUnit = _isIssue ?
                debtUnit.preciseMul(_quantity) :
                debtUnit.preciseMulCeil(_quantity);

        return (component, totalEquityUnit, totalDebtUnit);
    }

    /**
    * Sums total debt and equity units for each component, taking into account default and external positions.
    *
    * ISSUE: 
    * ======
    * Issuing index is dependent on current leverage of index position in Aave and current price of 
    * collateral asset against borrowed asset.
    * In order to issue new index unit multiply the following factor by default position 
    * Factor_{i} = [leverage * (1 - initPrice/price) + initPrice/price] * Factor_{i-1}
    * This factor accumulates throughout leverages and deleverages 
    *
    * REDEEM:
    * =======
    * Redeeming index depends mainly on the current state of the underlying assets of the index at the
    * moment of redemption.
    * Redemption unit = (totalCollateral - totalDebt`) / supply 
    * Note that totalDebt` represent the debt amount in collateral asset equivalent to that of the actual
    * debt (totalDebt) in borrow asset. It can be estimated as follow:
    * totalDebt` =  UniswapRouter.getAmountsIn(totalDebt, [collateral_asset, borrow_asset])
    *
    * @param _setToken         Instance of the SetToken to issue
    *
    * @return address        component addresses making up the Set
    * @return uint256        equity unit amounts of component, represented as uint256
    * @return uint256        debt unit amounts of component, represented as uint256
    */
    function _getTotalIssuanceUnitsV2(
        ISetToken _setToken,
        bool _isIssue
    )
        internal
        view
        returns (address , uint256 , uint256 )
    {
        // First asset of components represents the aToken of the baseToken 
        address[] memory components = _setToken.getComponents();


        // Considering issuing factor for price change (oracle) and leveraging
        uint256 factor = _setToken.calculateIssuingFactor();
        (
            uint256 unitCollateral, 
            uint256 unitDebt
        ) = _calculcateUnitsFromTotal(
            _setToken, 
            components, 
            factor, 
            _isIssue
        );
            
       uint256 cumulativeEquity =  unitCollateral.sub(unitDebt);

        return (components[0], cumulativeEquity, 0);
    }
    function _calculcateUnitsFromTotal(
        ISetToken _setToken,
        address[] memory _components,
        uint256 _factor,
        bool _isIssue
    )
    internal
    view
    returns (uint256 _unitCollateral, uint256 _unitDebt)
    {

        uint256 setTotalSupply = _setToken.totalSupply();
        ILendingPool lender = ILendingPool(lendingPoolAddressesProvider.getLendingPool());  

        (
            uint256 totalCollateralETH, 
            uint256 totalDebtETH,
        ,,,) = lender.getUserAccountData(address(_setToken)); 
        // unitCollateral represents base (not ETH)
        _unitCollateral = _isIssue? 
                    _factor
                    .preciseMulCeil(_setToken.getDefaultPositionRealUnit(_components[0]).toUint256()): 
                    totalCollateralETH
                    .preciseDiv(setTotalSupply)
                    .preciseDiv(_setToken.assetPriceInETH(lendingPoolAddressesProvider, IndexUtils.AssetType.COLLATERAL))  // 
                    .preciseMul(IERC20(_components[0]).getUnitOf()) ;
            
            // Considering successive delever loss due to swap fees and price deviation which increases debt
            // getAmountsIn(totalDebtETH*oraclePrice) / setTotalSupply
            // NOTE totalDebtETH represents base (not ETH) after executing method
            totalDebtETH = _setToken.calculateDebtWithSwapFees(
                lendingPoolAddressesProvider, 
                _getUniswapSpender(),
                totalDebtETH
            ); 
            _unitDebt = _isIssue? 0:totalDebtETH.preciseDivCeil(setTotalSupply);
    }

    /**
     * Justification: Utilizing multiple delevers in one txn might output a miscalculation 
     * with getIssuanceUnits.
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
        require(setTokenComponentBalance.preciseMul(1.01 ether) >= _componentQuantity, "Amount exceeds available balance");
        _componentTransferrableQuantity = setTokenComponentBalance >= _componentQuantity?
                        _componentQuantity:
                        setTokenComponentBalance;
    }

    /* ============== View Functions ============*/

    function _getUniswapSpender() internal view returns (IUniswapV2Router _router)
    {
        _router = IUniswapV2Router(
            IExchangeAdapter(getAndValidateAdapter(UNISWAP_INTEGRATION)).getSpender()
        );
    }
}