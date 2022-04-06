pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

import { IntegrationRegistry } from "@setprotocol/set-protocol-v2/contracts/protocol/IntegrationRegistry.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";

/**
 * @title IntegrationRegistry
 * @author IndexTech Ltd.
 *
 * The IntegrationRegistry holds state relating to the Modules and the integrations they are connected with.
 * The state is combined into a single Registry to allow governance updates to be aggregated to one contract.
 */
contract IntegrationRegistryMock is IntegrationRegistry {
    
    /**
     * Initializes the controller
     *
     * @param _controller          Instance of the controller
     */
    constructor(IController _controller) public IntegrationRegistry(_controller) {}
}