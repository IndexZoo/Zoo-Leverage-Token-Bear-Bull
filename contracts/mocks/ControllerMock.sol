pragma solidity 0.6.10;

import {Controller} from "@setprotocol/set-protocol-v2/contracts/protocol/Controller.sol";


contract ControllerMock is Controller {

    constructor(address _feeRecipient) public Controller(_feeRecipient) {}
}