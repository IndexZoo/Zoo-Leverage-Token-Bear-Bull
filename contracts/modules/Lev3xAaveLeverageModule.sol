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
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { AaveV2 } from "@setprotocol/set-protocol-v2/contracts/protocol/integration/lib/AaveV2.sol";
import { IAToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/IAToken.sol";
import { IController } from "@setprotocol/set-protocol-v2/contracts/interfaces/IController.sol";
import { IDebtIssuanceModule } from "@setprotocol/set-protocol-v2/contracts/interfaces/IDebtIssuanceModule.sol";
import { IExchangeAdapter } from "@setprotocol/set-protocol-v2/contracts/interfaces/IExchangeAdapter.sol";
import { ILendingPool } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/ILendingPool.sol";
import { ILendingPoolAddressesProvider } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/ILendingPoolAddressesProvider.sol";
import { IModuleIssuanceHook } from "@setprotocol/set-protocol-v2/contracts/interfaces/IModuleIssuanceHook.sol";
import { IProtocolDataProvider } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/IProtocolDataProvider.sol";
import { ISetToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/ISetToken.sol";
import { IVariableDebtToken } from "@setprotocol/set-protocol-v2/contracts/interfaces/external/aave-v2/IVariableDebtToken.sol";
import { ModuleBase } from "@setprotocol/set-protocol-v2/contracts/protocol/lib/ModuleBase.sol";
import { IUniswapV2Router } from "../interfaces/IUniswapV2Router.sol";
import { PreciseUnitMath } from "@setprotocol/set-protocol-v2/contracts/lib/PreciseUnitMath.sol";
import { IPriceOracleGetter } from "../interfaces/IPriceOracleGetter.sol";
import { IndexUtils } from "../lib/IndexUtils.sol";


/**
 * @title AaveLeverageModule
 * @author IndexZoo 
 * @notice Smart contract that enables leverage trading using Aave as the lending protocol. 
 * @dev Do not use this module in conjunction with other debt modules that allow Aave debt positions as it could lead to double counting of
 * debt when borrowed assets are the same.
 */
contract Lev3xAaveLeverageModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook {
    using AaveV2 for ISetToken;
    using IndexUtils for ISetToken;
    using IndexUtils for IUniswapV2Router;

    /* ============ Structs ============ */

    struct EnabledAssets {        
        address collateralAssets;             // Array of enabled underlying collateral assets for a SetToken
        address borrowAssets;                 // Array of enabled underlying borrow assets for a SetToken
    }

    struct ActionInfo {
        ISetToken setToken;                      // SetToken instance
        ILendingPool lendingPool;                // Lending pool instance, we grab this everytime since it's best practice not to store
        IExchangeAdapter exchangeAdapter;        // Exchange adapter instance
        uint256 setTotalSupply;                  // Total supply of SetToken
        uint256 notionalSendQuantity;            // Total notional quantity sent to exchange
        uint256 minNotionalReceiveQuantity;      // Min total notional received from exchange
        IERC20 collateralAsset;                  // Address of collateral asset
        IERC20 borrowAsset;                      // Address of borrow asset
        uint256 preTradeReceiveTokenBalance;     // Balance of pre-trade receive token balance
    }

    struct ReserveTokens {
        IAToken aToken;                         // Reserve's aToken instance
        IVariableDebtToken variableDebtToken;   // Reserve's variable debt token instance
    }

    struct LeveragingStateInfo {
        ISetToken setToken;                                           // SetToken instance
        IERC20 collateralAsset;                                       // Address of collateral asset
        IERC20 borrowAsset;                                           // Address of borrow asset
        uint256 accumulatedMultiplier;                                // Multiplier accumulated throughout
        uint256 initPrice;                                            // Price recorded during last lever/delever
        uint256 initLeverage;                                         // Leverage recorded during last lever/delever 
    }
    
    /* ============ Events ============ */

    /**
     * @dev Emitted on lever()
     * @param _setToken             Instance of the SetToken being levered
     * @param _borrowAsset          Asset being borrowed for leverage
     * @param _collateralAsset      Collateral asset being levered
     * @param _exchangeAdapter      Exchange adapter used for trading
     * @param _totalBorrowAmount    Total amount of `_borrowAsset` borrowed
     * @param _totalReceiveAmount   Total amount of `_collateralAsset` received by selling `_borrowAsset`
     * @param _protocolFee          Protocol fee charged
     */
    event LeverageIncreased(
        ISetToken indexed _setToken,
        IERC20 indexed _borrowAsset,
        IERC20 indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalBorrowAmount,
        uint256 _totalReceiveAmount,
        uint256 _protocolFee
    );

    /**
     * @dev Emitted on delever() and deleverToZeroBorrowBalance()
     * @param _setToken             Instance of the SetToken being delevered
     * @param _collateralAsset      Asset sold to decrease leverage
     * @param _repayAsset           Asset being bought to repay to Aave
     * @param _exchangeAdapter      Exchange adapter used for trading
     * @param _totalRedeemAmount    Total amount of `_collateralAsset` being sold
     * @param _totalRepayAmount     Total amount of `_repayAsset` being repaid
     * @param _protocolFee          Protocol fee charged
     */
    event LeverageDecreased(
        ISetToken indexed _setToken,
        IERC20 indexed _collateralAsset,
        IERC20 indexed _repayAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalRedeemAmount,
        uint256 _totalRepayAmount,
        uint256 _protocolFee
    );

    /**
     * @dev Emitted on addCollateralAssets() and removeCollateralAssets()
     * @param _setToken Instance of SetToken whose collateral assets is updated
     * @param _added    true if assets are added false if removed
     * @param _assets   Array of collateral assets being added/removed
     */
    event CollateralAssetsUpdated(
        ISetToken indexed _setToken,
        bool indexed _added,
        IERC20 _assets
    );

    /**
     * @dev Emitted on addBorrowAssets() and removeBorrowAssets()
     * @param _setToken Instance of SetToken whose borrow assets is updated
     * @param _added    true if assets are added false if removed
     * @param _assets   Array of borrow assets being added/removed
     */
    event BorrowAssetsUpdated(
        ISetToken indexed _setToken,
        bool indexed _added,
        IERC20 _assets
    );
    
    /**
     * @dev Emitted when `underlyingToReserveTokensMappings` is updated
     * @param _underlying           Address of the underlying asset
     * @param _aToken               Updated aave reserve aToken
     * @param _variableDebtToken    Updated aave reserve variable debt token 
     */
    event ReserveTokensUpdated(
        IERC20 indexed _underlying,
        IAToken indexed _aToken,
        IVariableDebtToken indexed _variableDebtToken
    );
    
    /**
     * @dev Emitted on updateAllowedSetToken()
     * @param _setToken SetToken being whose allowance to initialize this module is being updated
     * @param _added    true if added false if removed
     */
    event SetTokenStatusUpdated(
        ISetToken indexed _setToken,
        bool indexed _added
    );

    /**
     * @dev Emitted on updateAnySetAllowed()
     * @param _anySetAllowed    true if any set is allowed to initialize this module, false otherwise
     */
    event AnySetAllowedUpdated(
        bool indexed _anySetAllowed    
    );

    /**
     * @dev Emitted on updateAnyBotAllowed()
     * @param _setToken         SetToken 
     * @param _allowed          true if bots are allowed, false otherwise 
     */
    event AnyBotAllowedUpdated(
        ISetToken _setToken,
        bool _allowed
    );

    /**
     * @dev Emitted on setCallerPermission()
     * @param _setToken         SetToken 
     * @param _caller           address of caller to be set permission for
     * @param _allowed          true if caller is allowed, false otherwise 
     */
    event CallerPermissionSet(
        ISetToken indexed _setToken,
        address indexed _caller,
        bool indexed _allowed
    );

    /* ============ Constants ============ */
 
    // This module only supports borrowing in variable rate mode from Aave which is represented by 2
    uint256 constant internal BORROW_RATE_MODE = 2;
    
    // String identifying the DebtIssuanceModule in the IntegrationRegistry. Note: Governance must add DefaultIssuanceModule as
    // the string as the integration name
    string constant internal DEFAULT_ISSUANCE_MODULE_NAME = "DefaultIssuanceModule";

    // 0 index stores protocol fee % on the controller, charged in the _executeTrade function
    uint256 constant internal PROTOCOL_TRADE_FEE_INDEX = 0;

    string constant public UNISWAP_INTEGRATION = "UNISWAP";  // For uniswap-like dex

    // Factor that represents the amount of output to be accepted within swapping 
    uint256 constant internal SWAP_LOWER_LIMIT = 0.95 ether;

    /* ============ State Variables ============ */

    // Mapping to efficiently fetch reserve token addresses. Tracking Aave reserve token addresses and updating them 
    // upon requirement is more efficient than fetching them each time from Aave.
    // Note: For an underlying asset to be enabled as collateral/borrow asset on SetToken, it must be added to this mapping first.
    mapping(IERC20 => ReserveTokens) public underlyingToReserveTokens;

    // Used to fetch reserves and user data from AaveV2
    IProtocolDataProvider public immutable protocolDataProvider;
    
    // Used to fetch lendingPool address. This contract is immutable and its address will never change.
    ILendingPoolAddressesProvider public immutable lendingPoolAddressesProvider;
    
    // Mapping to efficiently check if collateral asset is enabled in SetToken
    mapping(ISetToken => mapping(IERC20 => bool)) public collateralAssetEnabled;
    
    // Mapping to efficiently check if a borrow asset is enabled in SetToken
    mapping(ISetToken => mapping(IERC20 => bool)) public borrowAssetEnabled;
    
    // Internal mapping of enabled collateral and borrow tokens for syncing positions
    mapping(ISetToken => EnabledAssets) internal enabledAssets;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list. Updateable by governance.
    bool public anySetAllowed;

    // Leveraging state recorded -- for issuing new tokens 
    mapping(ISetToken => LeveragingStateInfo) public leveragingStateInfo;

    // Are bots permitted for a specified setToken
    mapping(ISetToken => bool) internal _anyBotAllowed;

    // Authorized bots for a specified setToken
    mapping(ISetToken => mapping(address => bool)) internal _authorizedCallers;

    /* ============ Modifiers ============ */

    /**
     * Authorize call to function being called if the caller is an allowed bot of the setToken
     */
    modifier onlyAuthorizedCallerAndValidSet(ISetToken _setToken)
    {
        _validateAuthorizedCallerAndValidSet( _setToken, msg.sender);
        _;
    }
    
    /* ============ Constructor ============ */

    /**
     * @dev Instantiate addresses. Underlying to reserve tokens mapping is created.
     * @param _controller                       Address of controller contract
     * @param _lendingPoolAddressesProvider     Address of Aave LendingPoolAddressProvider
     */
    constructor(
        IController _controller,
        ILendingPoolAddressesProvider _lendingPoolAddressesProvider
    )
        public
        ModuleBase(_controller)
    {
        lendingPoolAddressesProvider = _lendingPoolAddressesProvider;
        IProtocolDataProvider _protocolDataProvider = IProtocolDataProvider(
            // Use the raw input vs bytes32() conversion. This is to ensure the input is an uint and not a string.
            _lendingPoolAddressesProvider.getAddress(0x0100000000000000000000000000000000000000000000000000000000000000)
        );
        protocolDataProvider = _protocolDataProvider;
        
        IProtocolDataProvider.TokenData[] memory reserveTokens = _protocolDataProvider.getAllReservesTokens();
        for(uint256 i = 0; i < reserveTokens.length; i++) {
            (address aToken, , address variableDebtToken) = _protocolDataProvider.getReserveTokensAddresses(reserveTokens[i].tokenAddress);
            underlyingToReserveTokens[IERC20(reserveTokens[i].tokenAddress)] = ReserveTokens(IAToken(aToken), IVariableDebtToken(variableDebtToken));
        }
    }
    
    /* ============ External Functions ============ */

    /**
     * @dev MANAGER ONLY: Increases leverage for a given base (collateral) token using an enabled borrow asset 
     * (e.g. usdc in bull case). Borrows _borrowAsset from Aave. Performs a DEX trade, exchanging the 
     * _borrowAsset for _collateralAsset. Deposits _collateralAsset to Aave and mints corresponding aToken.
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this
     * on Initialize.
     * Note: example: 
     *  lever(
     *    index.address,
     *    usdc.address,     // borrow asset
     *    weth.address,     // collateral asset 
     *    ether(800),       // quantityUnit = totalQuantityToBorrow/totalSupplyOfIndex
     *    ether(0.75),      // minQuantityUnit = totalQuantityToReceiveSwap/totalSupplyOfIndex
     *    "UNISWAP",
     *    "0x"
     *  );
     *
     * @param _setToken                     Instance of the SetToken
     * @param _borrowAsset                  Address of underlying asset being borrowed for leverage
     * @param _collateralAsset              Address of underlying collateral asset
     * @param _borrowQuantityUnits          Borrow quantity of asset in position units
     * @param _minReceiveQuantityUnits      Min receive quantity of collateral asset to receive post-trade in position units
     * @param _tradeAdapterName             Name of trade adapter
     * @param _tradeData                    Arbitrary data for trade
     */
    function lever(
        ISetToken _setToken,
        IERC20 _borrowAsset,
        IERC20 _collateralAsset,
        uint256 _borrowQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        _lever(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            _borrowQuantityUnits,
            _minReceiveQuantityUnits,
            _tradeAdapterName,
            _tradeData
        );
    }
    
    /**
     * @dev MANAGER ONLY: Decrease leverage for a given collateral (base) token using an enabled borrow asset.
     * Withdraws _collateralAsset from Aave. Performs a DEX trade, exchanging the _collateralAsset for _repayAsset 
     * (i.e. borrowAsset). Repays _repayAsset to Aave and decreases leverage of index accordingly.
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this
     * on initialize.
     * 
     * @param _setToken                 Instance of the SetToken
     * @param _collateralAsset          Address of underlying collateral asset being withdrawn
     * @param _repayAsset               Address of underlying borrowed asset being repaid
     * @param _redeemQuantityUnits      Quantity of collateral asset to delever in position units
     * @param _minRepayQuantityUnits    Minimum amount of repay asset to receive post trade in position units
     * @param _tradeAdapterName         Name of trade adapter
     * @param _tradeData                Arbitrary data for trade
     */
    function delever(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantityUnits,
        uint256 _minRepayQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external 
        nonReentrant
        onlyManagerAndValidSet(_setToken)  
    {
        _delever(
            _setToken,
            _collateralAsset,
            _repayAsset,
            _redeemQuantityUnits,
            _minRepayQuantityUnits,
            _tradeAdapterName,
            _tradeData
        );
    }

    /**
     * @dev AUTHORIZED CALLER (BOT) ONLY: Increases leverage for a given base (collateral) token using an enabled borrow asset 
     * (e.g. usdc in bull case). Borrows _borrowAsset from Aave. Performs a DEX trade, exchanging the 
     * _borrowAsset for _collateralAsset. Deposits _collateralAsset to Aave and mints corresponding aToken.
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this
     * on Initialize.
     * @param _setToken                     Instance of the SetToken
     * @param _borrowAsset                  Address of underlying asset being borrowed for leverage
     * @param _collateralAsset              Address of underlying collateral asset
     * @param _borrowQuantityUnits          Borrow quantity of asset in position units
     * @param _minReceiveQuantityUnits      Min receive quantity of collateral asset to receive post-trade in position units
     * @param _tradeAdapterName             Name of trade adapter
     * @param _tradeData                    Arbitrary data for trade
     */
    function autoLever(
        ISetToken _setToken,
        IERC20 _borrowAsset,
        IERC20 _collateralAsset,
        uint256 _borrowQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyAuthorizedCallerAndValidSet(_setToken)
    {
        _lever(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            _borrowQuantityUnits,
            _minReceiveQuantityUnits,
            _tradeAdapterName,
            _tradeData
        );
    }
    
    /**
     * @dev AUTHORIZED CALLER (BOT) ONLY: Decrease leverage for a given collateral (base) token using an enabled borrow asset.
     * Withdraws _collateralAsset from Aave. Performs a DEX trade, exchanging the _collateralAsset for _repayAsset 
     * (i.e. borrowAsset). Repays _repayAsset to Aave and decreases leverage of index accordingly.
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset. Do this
     * on initialize.
     *
     * Note: This is CRITICAL to be called if position health factor becomes low.
     *
     * @param _setToken                 Instance of the SetToken
     * @param _collateralAsset          Address of underlying collateral asset being withdrawn
     * @param _repayAsset               Address of underlying borrowed asset being repaid
     * @param _redeemQuantityUnits      Quantity of collateral asset to delever in position units
     * @param _minRepayQuantityUnits    Minimum amount of repay asset to receive post trade in position units
     * @param _tradeAdapterName         Name of trade adapter
     * @param _tradeData                Arbitrary data for trade
     */
    function autoDelever(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantityUnits,
        uint256 _minRepayQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external 
        nonReentrant
        onlyAuthorizedCallerAndValidSet(_setToken)  
    {
        _delever(
            _setToken,
            _collateralAsset,
            _repayAsset,
            _redeemQuantityUnits,
            _minRepayQuantityUnits,
            _tradeAdapterName,
            _tradeData
        );
    }

    /**
     * IMPLEMENTED BY SETLABS
     * @dev MANAGER ONLY: Pays down the borrow asset to 0 selling off a given amount of collateral asset. 
     * Withdraws _collateralAsset from Aave. Performs a DEX trade, exchanging the _collateralAsset for _repayAsset. 
     * Minimum receive amount for the DEX trade is set to the current variable debt balance of the borrow asset. 
     * Repays received _repayAsset to Aave which burns corresponding debt tokens. Any extra received borrow asset is .
     * updated as equity. No protocol fee is charged.
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset.
     * The function reverts if not enough collateral asset is redeemed to buy the required minimum amount of _repayAsset.
     * @param _setToken             Instance of the SetToken
     * @param _collateralAsset      Address of underlying collateral asset being redeemed
     * @param _repayAsset           Address of underlying asset being repaid
     * @param _redeemQuantityUnits  Quantity of collateral asset to delever in position units
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade     
     * @return uint256              Notional repay quantity
     */
    function deleverToZeroBorrowBalance(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns (uint256)
    {
        uint256 setTotalSupply = _setToken.totalSupply();
        uint256 notionalRedeemQuantity = _redeemQuantityUnits.preciseMul(setTotalSupply);
        
        require(borrowAssetEnabled[_setToken][_repayAsset], "Borrow not enabled");
        uint256 notionalRepayQuantity = underlyingToReserveTokens[_repayAsset].variableDebtToken.balanceOf(address(_setToken));
        require(notionalRepayQuantity > 0, "Borrow balance is zero");

        ActionInfo memory deleverInfo = _createAndValidateActionInfoNotional(
            _setToken,
            _collateralAsset,
            _repayAsset,
            notionalRedeemQuantity,
            notionalRepayQuantity,
            _tradeAdapterName,
            false,
            setTotalSupply
        );

        _withdraw(deleverInfo.setToken, deleverInfo.lendingPool, _collateralAsset, deleverInfo.notionalSendQuantity);

        _executeTrade(deleverInfo, _collateralAsset, _repayAsset, _tradeData);

        _repayBorrow(deleverInfo.setToken, deleverInfo.lendingPool, _repayAsset, notionalRepayQuantity);

        _updateDeleverPositions(deleverInfo, _repayAsset);

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            notionalRepayQuantity,
            0   // No protocol fee
        );

        return notionalRepayQuantity;
    }

    /**
     * @dev MANAGER ONLY: Initializes this module to the SetToken. Either the SetToken needs to be on the allowed list
     * or anySetAllowed needs to be true. Only callable by the SetToken's manager.
     * Note: Managers can enable collateral and borrow assets that don't exist as positions on the SetToken
     * @param _setToken             Instance of the SetToken to initialize
     * @param _collateralAssets     Underlying tokens to be enabled as collateral in the SetToken
     * @param _borrowAssets         Underlying tokens to be enabled as borrow in the SetToken
     */
    function initialize(
        ISetToken _setToken,
        IERC20 _collateralAssets,
        IERC20 _borrowAssets
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        if (!anySetAllowed) {
            require(allowedSetTokens[_setToken], "Not allowed SetToken");
        }

        // Initialize module before trying register
        _setToken.initializeModule();

        // Get debt issuance module registered to this module and require that it is initialized
        require(_setToken.isInitializedModule(getAndValidateAdapter(DEFAULT_ISSUANCE_MODULE_NAME)), "Issuance not initialized");

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).registerToIssuanceModule(_setToken) {} catch {}
        }
        
        // _collateralAssets and _borrowAssets arrays are validated in their respective internal functions
        _addCollateralAssets(_setToken, _collateralAssets);
        _addBorrowAssets(_setToken, _borrowAssets);
        _initializeLeveragingStateInfo(_setToken, _collateralAssets, _borrowAssets);
    }

    /**
     * @dev MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Any deposited collateral assets
     * are disabled to be used as collateral on Aave. Aave Settings and manager enabled assets state is deleted.      
     * Note: Function will revert if there is any debt remaining on Aave
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        address borrowAssets = enabledAssets[setToken].borrowAssets;
            IERC20 borrowAsset = IERC20(borrowAssets);
            require(underlyingToReserveTokens[borrowAsset].variableDebtToken.balanceOf(address(setToken)) == 0, "Variable debt remaining");
    
            delete borrowAssetEnabled[setToken][borrowAsset];

        address collateralAssets = enabledAssets[setToken].collateralAssets;
            IERC20 collateralAsset = IERC20(collateralAssets);
            _updateUseReserveAsCollateral(setToken, collateralAsset, false);

            delete collateralAssetEnabled[setToken][collateralAsset];
        
        delete enabledAssets[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
        }
    }

    /**
     * @dev MANAGER ONLY: Add registration of this module on the debt issuance module for the SetToken. 
     * Note: if the debt issuance module is not added to SetToken before this module is initialized, then this function
     * needs to be called if the debt issuance module is later added and initialized to prevent state inconsistencies
     * @param _setToken             Instance of the SetToken
     * @param _debtIssuanceModule   Debt issuance module address to register
     */
    function registerToModule(ISetToken _setToken, IDebtIssuanceModule _debtIssuanceModule) external onlyManagerAndValidSet(_setToken) {
        require(_setToken.isInitializedModule(address(_debtIssuanceModule)), "Issuance not initialized");

        _debtIssuanceModule.registerToIssuanceModule(_setToken);
    }

    /**
     * @dev MANAGER ONLY: Add collateral assets. aTokens corresponding to collateral assets are tracked for syncing positions.
     * Note: Reverts with "Collateral already enabled" if there are duplicate assets in the passed _newCollateralAssets array.
     * 
     * NOTE: ALL ADDED COLLATERAL ASSETS CAN BE ADDED AS A POSITION ON THE SET TOKEN WITHOUT MANAGER'S EXPLICIT PERMISSION.
     * UNWANTED EXTRA POSITIONS CAN BREAK EXTERNAL LOGIC, INCREASE COST OF MINT/REDEEM OF SET TOKEN, AMONG OTHER POTENTIAL UNINTENDED CONSEQUENCES.
     * SO, PLEASE ADD ONLY THOSE COLLATERAL ASSETS WHOSE CORRESPONDING aTOKENS ARE NEEDED AS DEFAULT POSITIONS ON THE SET TOKEN.
     *
     * @param _setToken             Instance of the SetToken
     * @param _newCollateralAssets  Addresses of new collateral underlying assets
     */
    function addCollateralAssets(ISetToken _setToken, IERC20 _newCollateralAssets) external onlyManagerAndValidSet(_setToken) {
        _addCollateralAssets(_setToken, _newCollateralAssets);
    }
   
    /**
     * @dev MANAGER ONLY: Remove collateral assets. Disable deposited assets to be used as collateral on Aave market.
     * @param _setToken             Instance of the SetToken
     * @param _collateralAssets     Addresses of collateral underlying assets to remove
     */
    function removeCollateralAssets(ISetToken _setToken, IERC20 _collateralAssets) external onlyManagerAndValidSet(_setToken) {
        
            IERC20 collateralAsset = _collateralAssets;
            require(collateralAssetEnabled[_setToken][collateralAsset], "Collateral not enabled");
            
            _updateUseReserveAsCollateral(_setToken, collateralAsset, false);
            
            delete collateralAssetEnabled[_setToken][collateralAsset];
            delete enabledAssets[_setToken].collateralAssets;
        emit CollateralAssetsUpdated(_setToken, false, _collateralAssets);
    }

    /**
     * @dev MANAGER ONLY: Add borrow assets. Debt tokens corresponding to borrow assets are tracked for syncing positions.
     * Note: Reverts with "Borrow already enabled" if there are duplicate assets in the passed _newBorrowAssets array.
     * @param _setToken             Instance of the SetToken
     * @param _newBorrowAssets      Addresses of borrow underlying assets to add
     */
    function addBorrowAssets(ISetToken _setToken, IERC20 _newBorrowAssets) external onlyManagerAndValidSet(_setToken) {
        _addBorrowAssets(_setToken, _newBorrowAssets);
    }

    /**
     * @dev MANAGER ONLY: Remove borrow assets.
     * Note: If there is a borrow balance, borrow asset cannot be removed
     * @param _setToken             Instance of the SetToken
     * @param _borrowAssets         Addresses of borrow underlying assets to remove
     */
    function removeBorrowAssets(ISetToken _setToken, IERC20 _borrowAssets) external onlyManagerAndValidSet(_setToken) {
        
            IERC20 borrowAsset = _borrowAssets;
            
            require(borrowAssetEnabled[_setToken][borrowAsset], "Borrow not enabled");
            require(underlyingToReserveTokens[borrowAsset].variableDebtToken.balanceOf(address(_setToken)) == 0, "Variable debt remaining");
    
            delete borrowAssetEnabled[_setToken][borrowAsset];
            delete enabledAssets[_setToken].borrowAssets;
        emit BorrowAssetsUpdated(_setToken, false, _borrowAssets);
    }

    /**
     * @dev GOVERNANCE ONLY: Enable/disable ability of a SetToken to initialize this module. Only callable by governance.
     * @param _setToken             Instance of the SetToken
     * @param _status               Bool indicating if _setToken is allowed to initialize this module
     */
    function updateAllowedSetToken(ISetToken _setToken, bool _status) external onlyOwner {
        require(controller.isSet(address(_setToken)) || allowedSetTokens[_setToken], "Invalid SetToken");
        allowedSetTokens[_setToken] = _status;
        emit SetTokenStatusUpdated(_setToken, _status);
    }

    /**
     * @dev GOVERNANCE ONLY: Toggle whether ANY SetToken is allowed to initialize this module. Only callable by governance.
     * @param _anySetAllowed             Bool indicating if ANY SetToken is allowed to initialize this module
     */
    function updateAnySetAllowed(bool _anySetAllowed) external onlyOwner {
        anySetAllowed = _anySetAllowed;
        emit AnySetAllowedUpdated(_anySetAllowed);
    }

    function moduleIssueHook(ISetToken _setToken, uint256 _setTokenQuantity)override external {}
    function moduleRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity)override external {}

    function componentIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool _isEquity
    ) external override {}


    /**
     * @dev MODULE ONLY: Hook called prior to looping through each component on redemption. Invokes repay after 
     * the issuance module transfers debt from the issuer. Only callable by valid module.
     * The call mainly task is to provide enough withdrawable amount for redeemer from SetToken. 
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken
     * @param _component            Address of component
     */
    function componentRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity, IERC20 _component, bool _isEquity) external override onlyModule(_setToken) {
        // Check hook not being called for an equity position. If hook is called with equity position and outstanding borrow position
        // exists the loan would be paid down twice, decollateralizing the Set
        if (!_isEquity) {
            address collateralAsset = enabledAssets[_setToken].collateralAssets;
            address repayAsset = enabledAssets[_setToken].borrowAssets;


            for (uint8 i= 0; i <29; i++) {
                // repayAmount can not be zero as long as position is healthy 
                (
                    uint256 repayAmount, 
                    uint256 withdrawable, 
                    uint256 totalDebtETH
                ) = _setToken.calculateRepayAllowances(lendingPoolAddressesProvider, _getUniswapSpender(), repayAsset, _setTokenQuantity);
                uint256 units = _setToken.calculateRedeemUnits(lendingPoolAddressesProvider, _setTokenQuantity);

                if(units <= withdrawable || totalDebtETH == 0) break;

                // Expected repayUnits
                uint256 minRepayQuantityUnits =  _getUniswapSpender().getSwapAmountOut(
                    repayAmount, 
                    collateralAsset,
                    repayAsset
                );

                _delever(
                        _setToken,
                        IERC20(collateralAsset),
                        IERC20(repayAsset),
                        repayAmount,
                        minRepayQuantityUnits.preciseMul(SWAP_LOWER_LIMIT),   //  
                        "UNISWAP",
                        "" 
                ); 
                require(i != 28 || units <= withdrawable || totalDebtETH == 0, "Not enough to be withdrawn" ) ; 
            }
        }
    }

    /**
     * @dev Sets the flag of bot permission on setToken to call module calls that are authorized for bots.
     * @param _setToken             Instance of the SetToken
     * @param _allowed              Flag to be assigned
     *  
     */
    function updateAnyBotAllowed( 
        ISetToken _setToken, 
        bool _allowed
    ) 
    external 
    onlyManagerAndValidSet(_setToken)  
    {
        _anyBotAllowed[_setToken] = _allowed;
        emit AnyBotAllowedUpdated(_setToken, _allowed);
    }

    /**
     * @dev Registers a bot to call authorized calls by setting a flag on its address for a specified setToken 
     * @param _setToken             Instance of the SetToken
     * @param _caller               Address of bot to be permitted (or prevented)
     * @param _allowed              Flag to be assigned
     */
    function setCallerPermission( 
        ISetToken _setToken, 
        address _caller, 
        bool _allowed
    ) 
    external 
    onlyManagerAndValidSet(_setToken)  
    {
        _authorizedCallers[_setToken][_caller] = _allowed;
        emit CallerPermissionSet(_setToken, _caller, _allowed);
    }
    
    /* ============ External Getter Functions ============ */

    /**
     * @dev Get enabled assets for SetToken. Returns an array of collateral and borrow assets.
     * @return Underlying collateral assets that are enabled
     * @return Underlying borrowed assets that are enabled
     */
    function getEnabledAssets(ISetToken _setToken) external view returns(address , address ) {
        return (
            enabledAssets[_setToken].collateralAssets,
            enabledAssets[_setToken].borrowAssets
        );
    }

    /**
     * Calculates the multiplier which represents the unit collateral cost to issue one setToken.
     * L_i: Leverage
     * p_i-1: init price
     * p_i: current price
     * m_i-1: accumulated multiplier
     * m_i: calculated multiplier
     * m_i = (L_i (1-p_i-1/p_i) - p_i-1/p_i)  * m_i-1
     * 
     */
    function getIssuingMultiplier (
        ISetToken _setToken
    ) 
    public 
    view 
    returns (uint256 _multiplier, uint256 _price) 
    {
        // price needs be within allowable range that is adjusted by tuning the leverage
        address collateralAsset = enabledAssets[_setToken].collateralAssets;
        address borrowAsset = enabledAssets[_setToken].borrowAssets;
        require(borrowAsset != address(0), "No issuing before assigning borrowAsset");
        uint256 initLeverage = leveragingStateInfo[_setToken].initLeverage;

        
        IPriceOracleGetter priceOracle = IPriceOracleGetter(lendingPoolAddressesProvider.getPriceOracle());
        _price = priceOracle.getAssetPrice(collateralAsset)
               .preciseDiv(priceOracle.getAssetPrice(borrowAsset));
        if(initLeverage == 1 ether) return (1 ether, _price);

        uint256 factor;
        uint256 priceDip = leveragingStateInfo[_setToken].initPrice.preciseDiv(_price) ;
        // TODO: validate price resides within valid range
        if(priceDip <= 1 ether) 
        {
            factor = initLeverage
                        .preciseMulCeil(1 ether - priceDip)
                        .add(leveragingStateInfo[_setToken].initPrice.preciseDivCeil(_price));
        }  else {
            factor =  leveragingStateInfo[_setToken].initPrice.preciseDivCeil(_price)
                        .sub(initLeverage.preciseMulCeil( priceDip - 1 ether));
        }
        _multiplier =  factor.preciseMulCeil(leveragingStateInfo[_setToken].accumulatedMultiplier);
    }


    /* ============ Internal Functions ============ */
    
    /**
     * @dev Invoke deposit from SetToken using AaveV2 library. Mints aTokens for SetToken.
     */
    function _deposit(ISetToken _setToken, ILendingPool _lendingPool, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeApprove(address(_asset), address(_lendingPool), _notionalQuantity);
        _setToken.invokeDeposit(_lendingPool, address(_asset), _notionalQuantity);
    }

    /**
     * @dev Invoke withdraw from SetToken using AaveV2 library. Burns aTokens and returns underlying to SetToken.
     */
    function _withdraw(ISetToken _setToken, ILendingPool _lendingPool, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeWithdraw(_lendingPool, address(_asset), _notionalQuantity);
    }

    /**
     * @dev Invoke repay from SetToken using AaveV2 library. Burns DebtTokens for SetToken.
     */
    function _repayBorrow(ISetToken _setToken, ILendingPool _lendingPool, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeApprove(address(_asset), address(_lendingPool), _notionalQuantity);
        _setToken.invokeRepay(_lendingPool, address(_asset), _notionalQuantity, BORROW_RATE_MODE);
    }

    /**
     * @dev Invoke borrow from the SetToken using AaveV2 library. Mints DebtTokens for SetToken.
     */
    function _borrow(ISetToken _setToken, ILendingPool _lendingPool, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeBorrow(_lendingPool, address(_asset), _notionalQuantity, BORROW_RATE_MODE);
    }

    
    /**
     * @dev Invokes approvals, gets trade call data from exchange adapter and invokes trade from SetToken
     * @return uint256     The quantity of tokens received post-trade
     */
    function _executeTrade(
        ActionInfo memory _actionInfo,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        bytes memory _data
    )
        internal
        returns (uint256)
    {
        ISetToken setToken = _actionInfo.setToken;
        uint256 notionalSendQuantity = _actionInfo.notionalSendQuantity;

        setToken.invokeApprove(
            address(_sendToken),
            _actionInfo.exchangeAdapter.getSpender(),
            notionalSendQuantity
        );

        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _actionInfo.exchangeAdapter.getTradeCalldata(
            address(_sendToken),
            address(_receiveToken),
            address(setToken),
            notionalSendQuantity,
            _actionInfo.minNotionalReceiveQuantity,
            _data
        );

        setToken.invoke(targetExchange, callValue, methodData);

        uint256 receiveTokenQuantity = _receiveToken.balanceOf(address(setToken)).sub(_actionInfo.preTradeReceiveTokenBalance);
        require(
            receiveTokenQuantity >= _actionInfo.minNotionalReceiveQuantity,
            "Slippage too high"
        );

        return receiveTokenQuantity;
    }

    /**
     * @dev Calculates protocol fee on module and pays protocol fee from SetToken     
     * @return uint256          Total protocol fee paid
     */
    function _accrueProtocolFee(ISetToken _setToken, IERC20 _receiveToken, uint256 _exchangedQuantity) internal returns(uint256) {
        uint256 protocolFeeTotal = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        
        payProtocolFeeFromSetToken(_setToken, address(_receiveToken), protocolFeeTotal);

        return protocolFeeTotal;
    }

    /**
     * @dev Updates the collateral (aToken held) and borrow position (variableDebtToken held) of the SetToken
     */
    function _updateLeverPositions(ActionInfo memory _actionInfo, IERC20 _borrowAsset) internal {
        IAToken aToken = underlyingToReserveTokens[_actionInfo.collateralAsset].aToken;
        _updateCollateralPosition(
            _actionInfo.setToken,
            aToken,
            _getCollateralPosition(
                _actionInfo.setToken,
                aToken,
                _actionInfo.setTotalSupply
            )
        );

        _updateBorrowPosition(
            _actionInfo.setToken,
            _borrowAsset,
            _getBorrowPosition(
                _actionInfo.setToken,
                _borrowAsset,
                _actionInfo.setTotalSupply
            )
        );
    }

    /**
     * @dev Updates positions as per _updateLeverPositions and updates Default position for borrow asset in case Set is
     * delevered all the way to zero any remaining borrow asset after the debt is paid can be added as a position.
     */
    function _updateDeleverPositions(ActionInfo memory _actionInfo, IERC20 _repayAsset) internal {
        // if amount of tokens traded for exceeds debt, update default position first to save gas on editing borrow position
        uint256 repayAssetBalance = _repayAsset.balanceOf(address(_actionInfo.setToken));
        if (repayAssetBalance != _actionInfo.preTradeReceiveTokenBalance) {
            _actionInfo.setToken.calculateAndEditDefaultPosition(
                address(_repayAsset),
                _actionInfo.setTotalSupply,
                _actionInfo.preTradeReceiveTokenBalance
            );
        }

        _updateLeverPositions(_actionInfo, _repayAsset);
    }
     
    /**
     * @dev Updates default position unit for given aToken on SetToken
     */
    function _updateCollateralPosition(ISetToken _setToken, IAToken _aToken, uint256 _newPositionUnit) internal {
        // _setToken.editDefaultPosition(address(_aToken), _newPositionUnit);
        // To be referenced in issue/redeem by _executeExternalPosition on this main component
        _setToken.editExternalPosition(address(_aToken), address(this), _newPositionUnit.toInt256(), "");  // 
    } 

    /**
     * @dev Updates external position unit for given borrow asset on SetToken
     */
    function _updateBorrowPosition(ISetToken _setToken, IERC20 _underlyingAsset, int256 _newPositionUnit) internal {
        _setToken.editExternalPosition(address(_underlyingAsset), address(this), _newPositionUnit, "");
    }

    /**
     * @dev Construct the ActionInfo struct for lever and delever
     * @return ActionInfo       Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfo(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _sendQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bool _isLever
    )
        internal
        view
        returns(ActionInfo memory)
    {
        uint256 totalSupply = _setToken.totalSupply();

        return _createAndValidateActionInfoNotional(
            _setToken,
            _sendToken,
            _receiveToken,
            _sendQuantityUnits.preciseMul(totalSupply),
            _minReceiveQuantityUnits.preciseMul(totalSupply),
            _tradeAdapterName,
            _isLever,
            totalSupply
        );
    }
    
    /**
     * @dev Construct the ActionInfo struct for lever and delever accepting notional units     
     * @return ActionInfo       Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfoNotional(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        string memory _tradeAdapterName,
        bool _isLever,
        uint256 _setTotalSupply
    )
        internal
        view
        returns(ActionInfo memory)
    {
        ActionInfo memory actionInfo = ActionInfo ({
            exchangeAdapter: IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName)),
            lendingPool: ILendingPool(lendingPoolAddressesProvider.getLendingPool()),
            setToken: _setToken,
            collateralAsset: _isLever ? _receiveToken : _sendToken,
            borrowAsset: _isLever ? _sendToken : _receiveToken,
            setTotalSupply: _setTotalSupply,
            notionalSendQuantity: _notionalSendQuantity,
            minNotionalReceiveQuantity: _minNotionalReceiveQuantity,
            preTradeReceiveTokenBalance: IERC20(_receiveToken).balanceOf(address(_setToken))
        });

        _validateCommon(actionInfo);

        return actionInfo;
    }

    /**
     * @dev Updates `underlyingToReserveTokens` mappings for given `_underlying` asset. Emits ReserveTokensUpdated event.
     */
    function _addUnderlyingToReserveTokensMapping(IERC20 _underlying) internal {
        (address aToken, , address variableDebtToken) = protocolDataProvider.getReserveTokensAddresses(address(_underlying));
        underlyingToReserveTokens[_underlying].aToken = IAToken(aToken);
        underlyingToReserveTokens[_underlying].variableDebtToken = IVariableDebtToken(variableDebtToken);

        emit ReserveTokensUpdated(_underlying, IAToken(aToken), IVariableDebtToken(variableDebtToken));
    }

    /**
     * @dev Add collateral assets to SetToken. Updates the collateralAssetsEnabled and enabledAssets mappings.
     * Emits CollateralAssetsUpdated event.
     */
    function _addCollateralAssets(ISetToken _setToken, IERC20 _newCollateralAssets) internal {
            IERC20 collateralAsset = _newCollateralAssets;
            
            _validateNewCollateralAsset(_setToken, collateralAsset);
            _updateUseReserveAsCollateral(_setToken, collateralAsset, true);
            
            collateralAssetEnabled[_setToken][collateralAsset] = true;
            enabledAssets[_setToken].collateralAssets = (address(collateralAsset));
        emit CollateralAssetsUpdated(_setToken, true, _newCollateralAssets);
    }

    /**
     * @dev Add borrow assets to SetToken. Updates the borrowAssetsEnabled and enabledAssets mappings.
     * Emits BorrowAssetsUpdated event.
     */
    function _addBorrowAssets(ISetToken _setToken, IERC20 _newBorrowAssets) internal {
            IERC20 borrowAsset = _newBorrowAssets;
            
            _validateNewBorrowAsset(_setToken, borrowAsset);
            
            borrowAssetEnabled[_setToken][borrowAsset] = true;
            enabledAssets[_setToken].borrowAssets = (address(borrowAsset));
        emit BorrowAssetsUpdated(_setToken, true, _newBorrowAssets);
    }

    /**
     * @dev Updates SetToken's ability to use an asset as collateral on Aave
     */
    function _updateUseReserveAsCollateral(ISetToken _setToken, IERC20 _asset, bool _useAsCollateral) internal {
        /*
        Note: Aave ENABLES an asset to be used as collateral by `to` address in an `aToken.transfer(to, amount)` call provided 
            1. msg.sender (from address) isn't the same as `to` address
            2. `to` address had zero aToken balance before the transfer 
            3. transfer `amount` is greater than 0
        
        Note: Aave DISABLES an asset to be used as collateral by `msg.sender`in an `aToken.transfer(to, amount)` call provided 
            1. msg.sender (from address) isn't the same as `to` address
            2. msg.sender has zero balance after the transfer

        Different states of the SetToken and what this function does in those states:

            Case 1: Manager adds collateral asset to SetToken before first issuance
                - Since aToken.balanceOf(setToken) == 0, we do not call `setToken.invokeUserUseReserveAsCollateral` because Aave 
                requires aToken balance to be greater than 0 before enabling/disabling the underlying asset to be used as collateral 
                on Aave markets.
        
            Case 2: First issuance of the SetToken
                - SetToken was initialized with aToken as default position
                - DebtIssuanceModule reads the default position and transfers corresponding aToken from the issuer to the SetToken
                - Aave enables aToken to be used as collateral by the SetToken
                - Manager calls lever() and the aToken is used as collateral to borrow other assets

            Case 3: Manager removes collateral asset from the SetToken
                - Disable asset to be used as collateral on SetToken by calling `setToken.invokeSetUserUseReserveAsCollateral` with 
                useAsCollateral equals false
                - Note: If health factor goes below 1 by removing the collateral asset, then Aave reverts on the above call, thus whole
                transaction reverts, and manager can't remove corresponding collateral asset
        
            Case 4: Manager adds collateral asset after removing it
                - If aToken.balanceOf(setToken) > 0, we call `setToken.invokeUserUseReserveAsCollateral` and the corresponding aToken 
                is re-enabled as collateral on Aave
        
            Case 5: On redemption/delever/liquidated and aToken balance becomes zero
                - Aave disables aToken to be used as collateral by SetToken

        Values of variables in below if condition and corresponding action taken:

        ---------------------------------------------------------------------------------------------------------------------
        | usageAsCollateralEnabled |  _useAsCollateral |   aToken.balanceOf()  |     Action                                 |
        |--------------------------|-------------------|-----------------------|--------------------------------------------|
        |   true                   |   true            |      X                |   Skip invoke. Save gas.                   |
        |--------------------------|-------------------|-----------------------|--------------------------------------------|
        |   true                   |   false           |   greater than 0      |   Invoke and set to false.                 |
        |--------------------------|-------------------|-----------------------|--------------------------------------------|
        |   true                   |   false           |   = 0                 |   Impossible case. Aave disables usage as  |
        |                          |                   |                       |   collateral when aToken balance becomes 0 |
        |--------------------------|-------------------|-----------------------|--------------------------------------------|
        |   false                  |   false           |     X                 |   Skip invoke. Save gas.                   |
        |--------------------------|-------------------|-----------------------|--------------------------------------------|
        |   false                  |   true            |   greater than 0      |   Invoke and set to true.                  |
        |--------------------------|-------------------|-----------------------|--------------------------------------------|
        |   false                  |   true            |   = 0                 |   Don't invoke. Will revert.               |
        ---------------------------------------------------------------------------------------------------------------------
        */
        (,,,,,,,,bool usageAsCollateralEnabled) = protocolDataProvider.getUserReserveData(address(_asset), address(_setToken));
        if (
            usageAsCollateralEnabled != _useAsCollateral
            && underlyingToReserveTokens[_asset].aToken.balanceOf(address(_setToken)) > 0
        ) {
            _setToken.invokeSetUserUseReserveAsCollateral(
                ILendingPool(lendingPoolAddressesProvider.getLendingPool()),
                address(_asset),
                _useAsCollateral
            );
        }
    }


    function _lever(
        ISetToken _setToken,
        IERC20 _borrowAsset,
        IERC20 _collateralAsset,
        uint256 _borrowQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        internal 
    {
        // For levering up, send quantity is derived from borrow asset and receive quantity is derived from 
        // collateral asset
        ActionInfo memory leverInfo = _createAndValidateActionInfo(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            _borrowQuantityUnits,
            _minReceiveQuantityUnits,
            _tradeAdapterName,
            true
        );

        _borrow(leverInfo.setToken, leverInfo.lendingPool, leverInfo.borrowAsset, leverInfo.notionalSendQuantity);

        uint256 postTradeReceiveQuantity = _executeTrade(leverInfo, _borrowAsset, _collateralAsset, _tradeData);

        uint256 protocolFee = _accrueProtocolFee(_setToken, _collateralAsset, postTradeReceiveQuantity);

        uint256 postTradeCollateralQuantity = postTradeReceiveQuantity.sub(protocolFee);

        _deposit(leverInfo.setToken, leverInfo.lendingPool, _collateralAsset, postTradeCollateralQuantity);

        _updateLeverPositions(leverInfo, _borrowAsset);
        
        _updateLeveragingStateInfo(_setToken);

        emit LeverageIncreased(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            leverInfo.exchangeAdapter,
            leverInfo.notionalSendQuantity,
            postTradeCollateralQuantity,
            protocolFee
        );
    }
    
    function _delever(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantityUnits,
        uint256 _minRepayQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        internal 
    {
        // Note: for delevering, send quantity is derived from collateral asset and receive quantity is derived from 
        // repay asset
        ActionInfo memory deleverInfo = _createAndValidateActionInfo(
            _setToken,
            _collateralAsset,
            _repayAsset,
            _redeemQuantityUnits,
            _minRepayQuantityUnits,
            _tradeAdapterName,
            false
        );

        _withdraw(deleverInfo.setToken, deleverInfo.lendingPool, _collateralAsset, deleverInfo.notionalSendQuantity);

        uint256 postTradeReceiveQuantity = _executeTrade(deleverInfo, _collateralAsset, _repayAsset, _tradeData);

        uint256 protocolFee = _accrueProtocolFee(_setToken, _repayAsset, postTradeReceiveQuantity);

        uint256 repayQuantity = postTradeReceiveQuantity.sub(protocolFee);

        _repayBorrow(deleverInfo.setToken, deleverInfo.lendingPool, _repayAsset, repayQuantity);

        _updateDeleverPositions(deleverInfo, _repayAsset);

        _updateLeveragingStateInfo(_setToken);

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            repayQuantity,
            protocolFee
        );
    }
    function _initializeLeveragingStateInfo(
        ISetToken _setToken,
        IERC20 _collateralAssets,
        IERC20 _borrowAssets
    )
    internal 
    {
        LeveragingStateInfo memory _info;
        _info.setToken = _setToken;
        _info.collateralAsset = _collateralAssets;
        _info.borrowAsset = _borrowAssets;
        _info.accumulatedMultiplier = 1 ether;
        _info.initLeverage = 1 ether;
        leveragingStateInfo[_setToken] = _info;


        IAToken aToken = underlyingToReserveTokens[ _collateralAssets].aToken;
        _updateCollateralPosition(
            _setToken,
            aToken,
            1 ether
        );
    }

    function _updateLeveragingStateInfo (ISetToken _setToken) internal 
    {
        // update initPrice, initLeverage & accumulatedMultiplier

        (
            uint256 multiplier,
            uint256 price
        ) = getIssuingMultiplier(_setToken);

        (
            uint256 totalCollateralETH, 
            uint256 totalDebtETH,
            ,,,
        ) = ILendingPool(lendingPoolAddressesProvider.getLendingPool()).getUserAccountData(address(_setToken)); 

        uint256 leverage = totalCollateralETH.preciseDiv(totalCollateralETH.sub(totalDebtETH));

        leveragingStateInfo[_setToken].initLeverage = leverage;
        leveragingStateInfo[_setToken].initPrice = price;
        leveragingStateInfo[_setToken].accumulatedMultiplier = multiplier;

    }

    /* ============== private views =============== */

    /**
     * @dev Validate common requirements for lever and delever
     */
    function _validateCommon(ActionInfo memory _actionInfo) internal view {
        require(collateralAssetEnabled[_actionInfo.setToken][_actionInfo.collateralAsset], "Collateral not enabled");
        require(borrowAssetEnabled[_actionInfo.setToken][_actionInfo.borrowAsset], "Borrow not enabled");
        require(_actionInfo.collateralAsset != _actionInfo.borrowAsset, "Collateral and borrow asset must be different");
        require(_actionInfo.notionalSendQuantity > 0, "Quantity is 0");
    }

    /**
     * @dev Validates if a new asset can be added as collateral asset for given SetToken
     */
    function _validateNewCollateralAsset(ISetToken _setToken, IERC20 _asset) internal view {
        require(!collateralAssetEnabled[_setToken][_asset], "Collateral already enabled");
        
        (address aToken, , ) = protocolDataProvider.getReserveTokensAddresses(address(_asset));
        require(address(underlyingToReserveTokens[_asset].aToken) == aToken, "Invalid aToken address");
        
        ( , , , , , bool usageAsCollateralEnabled, , , bool isActive, bool isFrozen) = protocolDataProvider.getReserveConfigurationData(address(_asset));
        // An active reserve is an alias for a valid reserve on Aave.
        // We are checking for the availability of the reserve directly on Aave rather than checking our internal `underlyingToReserveTokens` mappings, 
        // because our mappings can be out-of-date if a new reserve is added to Aave
        require(isActive, "Invalid aave reserve");
        // A frozen reserve doesn't allow any new deposit, borrow or rate swap but allows repayments, liquidations and withdrawals
        require(!isFrozen, "Frozen aave reserve");
        require(usageAsCollateralEnabled, "Collateral disabled on Aave");
    }

    /**
     * @dev Validates if a new asset can be added as borrow asset for given SetToken
     */
    function _validateNewBorrowAsset(ISetToken _setToken, IERC20 _asset) internal view {
        require(!borrowAssetEnabled[_setToken][_asset], "Borrow already enabled");
        
        ( , , address variableDebtToken) = protocolDataProvider.getReserveTokensAddresses(address(_asset));
        require(address(underlyingToReserveTokens[_asset].variableDebtToken) == variableDebtToken, "Invalid variable debt token address");
        
        (, , , , , , bool borrowingEnabled, , bool isActive, bool isFrozen) = protocolDataProvider.getReserveConfigurationData(address(_asset));
        require(isActive, "Invalid aave reserve");
        require(!isFrozen, "Frozen aave reserve");
        require(borrowingEnabled, "Borrowing disabled on Aave");
    }

    /**
     * @dev Reads aToken balance and calculates default position unit for given collateral aToken and SetToken
     *
     * @return uint256       default collateral position unit          
     */
    function _getCollateralPosition(ISetToken _setToken, IAToken _aToken, uint256 _setTotalSupply) internal view returns (uint256) {
        return _setToken.getDefaultPositionRealUnit(address(_aToken)).toUint256();
    }
    
    /**
     * @dev Reads variableDebtToken balance and calculates external position unit for given borrow asset and SetToken
     *
     * @return int256       external borrow position unit
     */
    function _getBorrowPosition(ISetToken _setToken, IERC20 _borrowAsset, uint256 _setTotalSupply) internal view returns (int256) {
        uint256 borrowNotionalBalance = underlyingToReserveTokens[_borrowAsset].variableDebtToken.balanceOf(address(_setToken));
        return borrowNotionalBalance.preciseDivCeil(_setTotalSupply).toInt256().mul(-1);
    }



    function _getUniswapSpender() internal view returns (IUniswapV2Router _router)
    {
        _router = IUniswapV2Router(
            IExchangeAdapter(getAndValidateAdapter(UNISWAP_INTEGRATION)).getSpender()
        );
    }

    /**
     * Caller must be an authorized bot and setToken must be valid and initialized
     */
    function _validateAuthorizedCallerAndValidSet(ISetToken _setToken, address _caller) internal view {
       require(_anyBotAllowed[_setToken] && _authorizedCallers[_setToken][_caller], "Must be the authorized caller");
       require(isSetValidAndInitialized(_setToken), "Must be a valid and initialized SetToken");
    }

}