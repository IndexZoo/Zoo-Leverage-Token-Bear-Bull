

pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IModuleIssuanceHookV3 as IModuleIssuanceHook} from "../interfaces/IModuleIssuanceHookV3.sol";
import { IUniswapV2Router } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/IUniswapV2Router.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IExchangeAdapterV3} from "../interfaces/IExchangeAdapterV3.sol";
import { IndexUtils } from "../lib/IndexUtils.sol";

import "hardhat/console.sol";

contract FlashLoanCallerMock {


    /* ==================== Struct ============================= */

    /* ============ Events ============ */


    /* ==================== State Variables ========================== */
   /* ============ Constructor ============ */
    
    constructor() public  {}

    /* ============ External Functions ============ */

}

 