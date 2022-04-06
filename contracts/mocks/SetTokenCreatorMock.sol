pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import { SetTokenCreator } from "@setprotocol/set-protocol-v2/contracts/protocol/SetTokenCreator.sol";

contract SetTokenCreatorMock is SetTokenCreator {
    constructor(IController _controller) public SetTokenCreator(_controller) {
        controller = _controller;
    }
}