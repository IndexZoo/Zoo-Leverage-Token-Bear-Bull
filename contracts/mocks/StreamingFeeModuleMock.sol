pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { StreamingFeeModule } from "@setprotocol/set-protocol-v2/contracts/protocol/modules/StreamingFeeModule.sol";
import { ModuleBase } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/ModuleBase.sol";
import { Position } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/Position.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IModuleIssuanceHookV3 as IModuleIssuanceHook} from "../interfaces/IModuleIssuanceHookV3.sol";
import { IUniswapV2Router } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/IUniswapV2Router.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IExchangeAdapterV3} from "../interfaces/IExchangeAdapterV3.sol";
import { IndexUtils } from "../lib/IndexUtils.sol";

contract StreamingFeeModuleMock is StreamingFeeModule {

   /* ============ Constructor ============ */
    
    constructor(IController _controller) public StreamingFeeModule (_controller) {}


}