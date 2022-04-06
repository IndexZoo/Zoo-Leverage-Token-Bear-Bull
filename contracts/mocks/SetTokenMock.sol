pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import {SetToken} from "@setprotocol/set-protocol-v2/contracts/protocol/SetToken.sol";



contract SetTokenMock is SetToken {
    
    constructor(
        address[] memory _components,
        int256[] memory _units,
        address[] memory _modules,
        IController _controller,
        address _manager,
        string memory _name,
        string memory _symbol
    )
        public
        SetToken(
            _components,
            _units,
            _modules,
            _controller,
            _manager,
            _name,
            _symbol
        )
    {
    }
}