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
import { IModuleIssuanceHook } from "@setprotocol/set-protocol-v2/contracts/interfaces/IModuleIssuanceHook.sol";
import { Invoke } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Invoke.sol";
import { Position } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Position.sol";
import { PreciseUnitMath } from "@setprotocol/set-protocol-v2/contracts/lib/PreciseUnitMath.sol";
import {console} from "hardhat/console.sol";

// TODO: access control (ownable)

interface IIssuanceModule {
    function registerToIssuanceModule(ISetToken _setToken) external; 
}

contract Lev3xModuleIssuanceHook is IModuleIssuanceHook {
    using Invoke for ISetToken;
    using Position for ISetToken;
    using SafeCast for int256;
    using PreciseUnitMath for uint256;

    IIssuanceModule public issuanceModule; 

    constructor (IIssuanceModule _issuanceModule) public {
        issuanceModule = _issuanceModule;
    }

    function initialize(ISetToken _setToken) external {
        _setToken.initializeModule();
        address[] memory  components = _setToken.getComponents();
        for (uint64 i; i < components.length; i++ ) {
            _setToken.addExternalPositionModule(components[i], address(this));
        }
    }

    function addExternalPosition(ISetToken _setToken, address _component, int256 _quantity) external {
        _setToken.editExternalPosition(_component, address(this), _quantity, "");
    }

     /**
     * MODULE ONLY: Adds calling module to array of modules that require they be called before component hooks are
     * called. Can be used to sync debt positions before issuance.
     *
     * @param _setToken             Instance of the SetToken to issue
     */
    function registerToIssuanceModule(ISetToken _setToken) external  {
        issuanceModule.registerToIssuanceModule(_setToken);
    }   

    function moduleIssueHook(ISetToken _setToken, uint256 _setTokenQuantity) external override {}
    function moduleRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity) external override {
        // console.log("preRedeemHook called");
        // // TODO: change virtualUnit
        // address[] memory  components = _setToken.getComponents();
        // for (uint64 i; i < components.length; i++ ) {
        //     _setToken.editExternalPosition(components[i], address(this), 0, "");
        // }
    }

    function componentIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool /* _isEquity */
    ) external override {
        // int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(address(_component), address(this));
        // uint256 totalNotionalExternalModule = _setTokenQuantity.preciseMul(externalPositionUnit.toUint256());

        // // Invoke the SetToken to send the token of total notional to this address
        // _setToken.invokeTransfer(address(_component), address(this), totalNotionalExternalModule);
    }

    function componentRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool /* _isEquity */
    ) external override {
        // Send the component to the settoken
        // int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(address(_component), address(this));
        // uint256 totalNotionalExternalModule = _setTokenQuantity.preciseMul(externalPositionUnit.toUint256());
        // _component.transfer(address(_setToken), totalNotionalExternalModule);
    }
}