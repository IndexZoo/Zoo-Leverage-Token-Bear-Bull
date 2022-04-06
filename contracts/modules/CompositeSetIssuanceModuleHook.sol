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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IUniswapV2Router } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/IUniswapV2Router.sol";
import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IModuleIssuanceHookV3 as IModuleIssuanceHook } from "../interfaces/IModuleIssuanceHookV3.sol";
import { Invoke } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Invoke.sol";
import { Position } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Position.sol";
import { ResourceIdentifier } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/ResourceIdentifier.sol";
import { PreciseUnitMath } from "@setprotocol/set-protocol-v2/contracts/lib/PreciseUnitMath.sol";
import { IExchangeAdapterV3} from "../interfaces/IExchangeAdapterV3.sol";
import { IndexUtils } from "../lib/IndexUtils.sol";
import "hardhat/console.sol";

contract CompositeSetIssuanceModuleHook is IModuleIssuanceHook, Ownable {
    using Invoke for ISetToken;
    using IndexUtils for ISetToken;
    using Position for ISetToken;
    using SafeCast for int256;
    using PreciseUnitMath for uint256;
    using ResourceIdentifier for IController;

    IController public controller;
    IERC20 public quote;
    IUniswapV2Router public router;

    constructor (IController _controller, IERC20 _quote, IUniswapV2Router _router) public {
        controller = _controller;
        quote = _quote;
        router = _router;
    }

    /**
     * MANAGER ONLY: Initializes this module to the SetToken with desired configuration. 
     * Only called by CompositeSetIssuanceModule
     * @param _setToken         Instance of the SetToken to issue
     */
    function initialize(ISetToken _setToken) external override onlyOwner {
        _setToken.initializeModule();
    }

    function moduleIssueHook(ISetToken _setToken, uint256 _setTokenQuantity) external override {}
    function moduleRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity) external override {}

    /**
     * Triggers the process of swapping quote for component. Only called by CompositeSetIssuanceModule.
     * @param _setToken                 Instance of the SetToken to issue
     * @param _quoteQuantityMax         Max Quantity of quote to swap
     * @param _componentQuantity        Component quantity to be output of swap 
     * @param _component                Address of component asset 
     */
    function componentIssueHook(
        ISetToken _setToken,
        uint256 _quoteQuantityMax,
        uint256 _componentQuantity,
        IERC20 _component,
        bool /* _isEquity */
    ) 
    external 
    override 
    onlyOwner 
    {
        _approveRouter(_setToken, address(quote), _quoteQuantityMax);
        // swapToExact > index amount = componentQuantity
        uint256[] memory amounts = _swapToIndex(_setToken, address(_component), _componentQuantity, _quoteQuantityMax);
    }

    /**
     * Triggers the process of swapping component for quote. Only called by CompositeSetIssuanceModule.
     * @param _setToken                 Instance of the SetToken to issue
     * @param _quoteQuantityMin         Min Quantity of quote to be output of swap
     * @param _componentQuantity        Component quantity to be input of swap 
     * @param _component                Address of component asset 
     */
    function componentRedeemHook(
        ISetToken _setToken,
        uint256 _quoteQuantityMin,
        uint256 _componentQuantity,
        IERC20 _component,
        bool /* _isEquity */
    ) 
    external 
    override
    onlyOwner
    {
        _approveRouter(_setToken, address(_component), _componentQuantity);
        uint256[] memory amounts = _swapToQuote(_setToken, address(_component), _componentQuantity, _quoteQuantityMin);
    }



    /* ============================= Private Functions ==================================== */

   /**
     * Instructs the SetToken to set approvals of the ERC20 token to a uniswap-like router.
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
        _invokeApprove(_setToken, _token, address(router), _quantity);
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

    /* ============ Private Functions ============ */

   /**
     * Swaps input exact quantity of component to corresponding amount of quote.
     *
     * @param _setToken                      SetToken instance to invoke
     * @param _component                     ERC20 component of index / input of swap
     * @param _componentQuantity             Desired input swap quantity of component 
     * @param _quoteComponentQuantityMin     Minimum allowed quantity of output of swap 
     */
    function _swapToQuote(
        ISetToken _setToken,
        address _component,
        uint256 _componentQuantity,
        uint256 _quoteComponentQuantityMin
    )
    private
    returns (uint256[] memory amounts)
    {
        IExchangeAdapterV3 adapter = IExchangeAdapterV3(getAndValidateAdapter("UNISWAP"));
        amounts = _setToken.invokeSwapExact(
            adapter, 
            _component,
            address(quote),
            _componentQuantity, 
            _quoteComponentQuantityMin
        );
    }

   /**
     * Swaps input amount of quote to exact quantity of component .
     *
     * @param _setToken                         SetToken instance to invoke
     * @param _component                        ERC20 component of Index / Output of swap
     * @param _componentQuantity                Desired output quantity of component 
     * @param _quoteComponentQuantityMax        Maximum allowed quantity of input of swap 
     */
    function _swapToIndex(
        ISetToken _setToken,
        address _component,
        uint256 _componentQuantity,
        uint256 _quoteComponentQuantityMax
    )
    private
    returns (uint256[] memory amounts)
    {
        IExchangeAdapterV3 adapter = IExchangeAdapterV3(getAndValidateAdapter("UNISWAP"));
        amounts = _setToken.invokeSwapToIndex(
            adapter, 
            address(quote),
            _component,
            _componentQuantity, 
            _quoteComponentQuantityMax 
        );
    }

    /**
     * Hashes the string and returns a bytes32 value
     */
    function getNameHash(string memory _name) internal pure returns(bytes32) {
        return keccak256(bytes(_name));
    }

    function getAndValidateAdapter(string memory _integrationName) internal view returns(address) { 
        bytes32 integrationHash = getNameHash(_integrationName);
        return getAndValidateAdapterWithHash(integrationHash);
    }

    /**
     * Gets the integration for the module with the passed in hash. Validates that the address is not empty
     */
    function getAndValidateAdapterWithHash(bytes32 _integrationHash) internal view returns(address) { 
        address adapter = controller.getIntegrationRegistry().getIntegrationAdapterWithHash(
            address(this),
            _integrationHash
        );

        require(adapter != address(0), "Must be valid adapter"); 
        return adapter;
    }
}