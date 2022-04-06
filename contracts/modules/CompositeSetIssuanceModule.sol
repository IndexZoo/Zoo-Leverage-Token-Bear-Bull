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

import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { DebtIssuanceModuleV2 } from "@setprotocol/set-protocol-v2/contracts/protocol/modules/DebtIssuanceModuleV2.sol";
import { ModuleBase } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/ModuleBase.sol";
import { Position } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Position.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IModuleIssuanceHookV3 as IModuleIssuanceHook} from "../interfaces/IModuleIssuanceHookV3.sol";
import { IUniswapV2Router } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/IUniswapV2Router.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IExchangeAdapterV3} from "../interfaces/IExchangeAdapterV3.sol";
import { IndexUtils } from "../lib/IndexUtils.sol";
import {CompositeSetIssuanceModuleHook} from "./CompositeSetIssuanceModuleHook.sol";

import "hardhat/console.sol";

/**
 * @title CompositeSetIssuanceModule
 * @author IndexZoo 
 *
 * The CompositeSetIssuanceModule is a module that enables users to issue and redeem SetTokens that represent an
 * underlying collateral of tokens (i.e index). 
 * These tokens provides the value for the set.
 * Users issue the index by providing a predetermined quote currency, typically a stable coin (i.e. dai).
 * Input quote is exchanged via uniswap-like protocol to the components of the index according the ratios determined 
 * by the positionUnits of the SetToken linked with this module.
 * Users redeem the index by burning quantity of the issued index and receive the underlying assets according
 * to the prementioned ratios.
 * Module hooks are added to allow for syncing of positions.
 * 
 * NOTE: 
 * CompositeSetIssuanceModule contract should confirm increase/decrease in balance of component held by the SetToken after every transfer in/out
 * for each component during issuance/redemption. 
 * In issue: Precalculation of input quote amount is estimated before actually minting index and receiving the 
 * underlying collateral.
 * In redeem: Precalculation of output quot amount is estimated before actually burning index quantity and sending 
 * underlying collateral to redeemer.
 */
contract CompositeSetIssuanceModule is ModuleBase, ReentrancyGuard {
    using IndexUtils for ISetToken;
    using Address for address;


    /* ==================== Struct ============================= */
    struct Config {
        IUniswapV2Router router;
        IERC20 quote;
    }

    /* ============ Events ============ */

    event SetTokenIssued(
        ISetToken indexed _setToken,
        address indexed _issuer,
        address indexed _to,
        uint256 _quantity                       // Quantity of SetToken to be Issued
    );

    event SetTokenRedeemed(
        ISetToken indexed _setToken,
        address indexed _redeemer,
        address indexed _to,
        uint256 _quantity                       // Quantity of SetToken to be Redeemed
    );

    /* ==================== State Variables ========================== */
    /**
     * Config configuration by module
     * configuration for a given token 
     * each token can have its own configuration
     * router e.g. uniswapRouter / quote e.g. dai
     */
    mapping(ISetToken=> Config) public configs;
    
    /* ============ Constructor ============ */
    
    constructor(IController _controller) public ModuleBase (_controller) {}

    /* ============ External Functions ============ */

    /**
     * Request minting a quantity of the SetToken paid for by quote. Quote pays for the components of SetToken 
     * by swapping it. Slippage is added to arguments to prevent sandwich attacks. 
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Quantity of SetToken to issue
     * @param _to               Address to mint SetToken to
     * @param _maxAmountIn      Slippage: max amount of quote to be tranferred for issuing
     */
    function issue(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        uint256 _maxAmountIn
    )
        external
        virtual
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        require(_quantity > 0, "Issue quantity must be > 0");

        (
            address[] memory components,
            uint256[] memory equityUnits
        ) = _calculateRequiredComponentIssuanceUnits(_setToken, _quantity, true);
        require (_sumOf(equityUnits) <= _maxAmountIn, "Index: insufficient amountIn"); 

        _resolveEquityPositions(_setToken, _quantity, _to, true, components, equityUnits, _maxAmountIn );
        _setToken.mint(_to, _quantity);

        emit SetTokenIssued(
            _setToken,
            msg.sender,
            _to,
            _quantity
        );
    }

    /**
     * Returns components from the SetToken, unwinds any external module component positions and burns the SetToken.
     * Component positions are redeemed in the form of the quote token configured.
     *
     * @param _setToken                  Instance of the SetToken to redeem
     * @param _quantity                  Quantity of SetToken to redeem then burn, if quantity is MAX_UINT
     * then it means redeem all balance of user
     * @param _to                        Address to send redeemed funds to
     * @param _minAmountRedeemed         Minimum amount of quote asset to be sent back in exchange of components
     */
    function redeem(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        uint256 _minAmountRedeemed
    )
        external
        virtual        
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        // redeem all amount
        if(_quantity == uint256(-1))  _quantity = _setToken.balanceOf(msg.sender);

        require(_quantity > 0, "Redeem quantity must be > 0");
        require(_quantity <= _setToken.balanceOf(msg.sender), "Not enough index");
        
        // Place burn after pre-redeem hooks because burning tokens may lead to false accounting of synced positions
        _setToken.burn(msg.sender, _quantity);

        (
            address[] memory components,
            uint256[] memory equityUnits
        ) = _calculateRequiredComponentIssuanceUnits(_setToken, _quantity, false);
        _validateAmountSlippage(equityUnits, _minAmountRedeemed);
        _resolveEquityPositions(_setToken, _quantity, _to, false, components, equityUnits, _minAmountRedeemed);

        emit SetTokenRedeemed(
            _setToken,
            msg.sender,
            _to,
            _quantity
        );
    }

    /**
     * MANAGER ONLY: Initializes this module to the SetToken with desired configuration. Issuance-related 
     * hooks are also deployed during initialization. Only callable by the SetToken's manager. 
     *
     * @param _setToken                     Instance of the SetToken to issue
     * @param _quote                        Address of quote asset
     * @param _router                       Address of uniswap-like swap router
     */
    function initialize(
        ISetToken _setToken,
        IERC20 _quote,
        IUniswapV2Router _router
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        address[] memory components = _setToken.getComponents();
        require(components.length > 1, "Index: not enough components");
        _setToken.initializeModule();
        Config memory config;
        config.router = _router;
        config.quote = _quote;
        configs[_setToken] = config;
       
        CompositeSetIssuanceModuleHook hook = new CompositeSetIssuanceModuleHook(controller, _quote, _router);
        for(uint16 i=0; i < components.length; i++) {
            _setToken.addExternalPositionModule(components[i], address(hook));
        }
    }

    /**
     * MANAGER ONLY: Initializes the issuance-related hooks priorly deployed by initialize(). Only callable
     * by the SetToken's manager. 
     *
     * @param _setToken                     Instance of the SetToken to issue
     */
    function initializeHook(
        ISetToken _setToken
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndInitializedSet(_setToken)
    {
        address externalModule = _validateInitializableHook(_setToken);
        IModuleIssuanceHook(externalModule).initialize(_setToken);
    }

    function removeModule() external override {}

    /* ============ Internal Functions ============ */

    /**
     * Resolve equity positions associated with SetToken. On issuance, the total equity position (in quote) for an asset (including default and external
     * positions) is transferred in. Then any external position hooks are called to execute the swapping operations.
     * On redemption all external positions are recalled by the external position hook, then those positions (in quote) are transferred back
     * to the _to address.
     */
    function _resolveEquityPositions(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentEquityQuantities,
        uint256 _amountThreshold
    )
        internal
    {
        if (_isIssue) {
            transferFrom(
                configs[_setToken].quote,
                msg.sender,
                address(_setToken),
                _sumOf(_componentEquityQuantities)
            );
        }
        uint256[] memory thresholds = _calculateSlippageAmounts(
            _componentEquityQuantities, 
            _amountThreshold,
            _isIssue
        );
        address component;
        uint256 componentQuantity;
        for (uint256 i = 0; i < _components.length; i++) {
            component = _components[i];
            if (_componentEquityQuantities[i] > 0) {
                componentQuantity = _quantity.preciseMul(_setToken.getDefaultPositionRealUnit(component).toUint256());
                componentQuantity = componentQuantity.preciseMul(IndexUtils.getUnitOf(component));  // ether, btc, ...etc
                _executeExternalPositionHooks(
                    _setToken,
                    thresholds[i],
                    componentQuantity,        // Exact
                    IERC20(component), 
                    _isIssue
                );
            }
        }
        if(!_isIssue) {
             _setToken.invokeTransfer(
                 address(configs[_setToken].quote), 
                 _to, 
                _sumOf(_componentEquityQuantities)
            );
        }
    }


    /**
     * Calculates the amount of each component needed to collateralize passed issue quantity of Sets. 
     * Can also be used to determine how much collateral will be returned on redemption.     
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Amount of Sets to be issued/redeemed
     * @param _isIssue          Whether Sets are being issued or redeemed
     *
     * @return address[]        Array of component addresses making up the Set
     * @return uint256[]        Array of equity amounts of each component in the value of quote, 
     * respectively, represented as uint256. This is the amount which the function aims to calculate
     */
    function _calculateRequiredComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue
    )
        internal
        view
        returns (address[] memory, uint256[] memory)
    {
        (
            address[] memory components,
            uint256[] memory equityUnits
        ) = _getTotalIssuanceUnits(_setToken);

        address _quote = address(configs[_setToken].quote);

        uint256 componentsLength = components.length;
        uint256[] memory totalEquityUnits = new uint256[](componentsLength);
        address [] memory path = new address[](2);
        for (uint256 i = 0; i < components.length; i++) {
            // Use preciseMulCeil to round up to ensure overcollateration when small issue quantities are provided
            // and preciseMul to round down to ensure overcollateration when small redeem quantities are provided
            uint256 totalUnits = _isIssue ?
                equityUnits[i].preciseMulCeil(_quantity) :
                equityUnits[i].preciseMul(_quantity);
            path[0] = _isIssue? _quote:components[i];
            path[1] = _isIssue? components[i]:_quote;
            
            totalEquityUnits[i] = _isIssue?
                configs[_setToken].router.getAmountsIn(totalUnits.preciseMul(IndexUtils.getUnitOf(components[i])), path)[0]:
                configs[_setToken].router.getAmountsOut(totalUnits.preciseMul(IndexUtils.getUnitOf(components[i])), path)[1];
        }

        return (components, totalEquityUnits );
    }

    /**
     * Total equity units for each component, taking into account default positions.
     *
     * @param _setToken         Instance of the SetToken to issue
     *
     * @return address[]        Array of component addresses making up the Set
     * @return uint256[]        Array of equity unit amounts in quote of each component, respectively, represented as uint256
     */
    function _getTotalIssuanceUnits(
        ISetToken _setToken
    )
        internal
        view
        returns (address[] memory, uint256[] memory)
    {
        address[] memory components = _setToken.getComponents();
        uint256 componentsLength = components.length;

        uint256[] memory equityUnits = new uint256[](componentsLength);

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            int256 cumulativeEquity = _setToken.getDefaultPositionRealUnit(component);
            equityUnits[i] = cumulativeEquity.toUint256();
        }

        return (components, equityUnits );
    }

    /**
     * For each component's external module positions, calculate the total quote quantity, and 
     * call the module's issue hook or redeem hook.
     * Note: It is possible that these hooks can cause the states of other modules to change.
     * It can be problematic if the hook called an external function that called back into a module, resulting in state inconsistencies.
     */
    function _executeExternalPositionHooks(
        ISetToken _setToken,
        uint256 _quoteQuantity,
        uint256 _componentQuantity,
        IERC20 _component,
        bool _isIssue
    )
        internal
    {
        address externalPositionModule = _setToken.getExternalPositionModules(address(_component))[0];
        if (_isIssue) {
            IModuleIssuanceHook(externalPositionModule).componentIssueHook(_setToken, _quoteQuantity, _componentQuantity, _component, true);
        } else {
            IModuleIssuanceHook(externalPositionModule).componentRedeemHook(_setToken, _quoteQuantity, _componentQuantity, _component, true);
        }
    }

    /* ============ Private Functions ============ */

    function _validateAmountSlippage(
        uint256[] memory equityQuantities,
        uint256 amountOutMin
    )
    private
    pure
    {
        require(_sumOf(equityQuantities) >= amountOutMin, "Index: Not enough amountOut");
    }

    function _validateInitializableHook(
        ISetToken _setToken
    )
    private
    view 
    returns (address externalModule)
    {
        address[] memory components = _setToken.getComponents();
        for(uint16 i=0; i < components.length; i++) {
            address[] memory externalModules = _setToken.getExternalPositionModules(components[i]);
            require(externalModules.length == 1, "Index: externalModules error");
            if (externalModule == address(0)) {
                externalModule = externalModules[0];
            }
            require(externalModule == externalModules[0], "Index: not same externalModule");
        }
    }

   /**
     * Instructs the SetToken to set approvals of the ERC20 token to a spender.
     *
     * @param _setToken        ZooToken instance to invoke
     * @param _token           ERC20 token to approve
     * @param _quantity        The quantity of allowance to allow
     */
    function _approveRouter(
        ISetToken _setToken,
        address _token,
        uint256 _quantity
    )
       private 
    {
        IUniswapV2Router spender = configs[_setToken].router;
        _invokeApprove(_setToken, _token, address(spender), _quantity);
    }

   /**
     * Instructs the SetToken to set approvals of the ERC20 token to a spender.
     *
     * @param _setToken        ZooToken instance to invoke
     * @param _token           ERC20 token to approve
     * @param _spender         The account allowed to spend the ZooToken's balance
     * @param _quantity        The quantity of allowance to allow
     */
    function _invokeApprove(
        ISetToken _setToken,
        address _token,
        address _spender,
        uint256 _quantity
    )
      private 
    {
        bytes memory callData = abi.encodeWithSignature("approve(address,uint256)", _spender, _quantity);
        _setToken.invoke(_token, 0, callData);
    }

    function _sumOf(
        uint256[] memory nums
    )
    private
    pure
    returns (uint256 total)
    {
        uint length = nums.length;
        if(length == 0)  return 0;
        for (uint i=0; i < length; i++) {
            total = total.add(nums[i]);
        }
    }

    function _calculateSlippageAmounts(
        uint256[] memory _expectedAmounts,
        uint256 _thresholdAmount,
        bool _isIssue
    )
    public
    pure
    returns (uint256[] memory ) 
    {
        uint256 total = _sumOf(_expectedAmounts);
        bool x = _isIssue? _thresholdAmount < total : total < _thresholdAmount;
        if(x) return _expectedAmounts;

        uint256[] memory _thresholdAmounts = new uint256[] (_expectedAmounts.length);
        for(uint i=0; i < _expectedAmounts.length; i++) {
            _thresholdAmounts[i] = _thresholdAmount.mul(_expectedAmounts[i]).div(total);
        }
        return _thresholdAmounts;
    }
}

 