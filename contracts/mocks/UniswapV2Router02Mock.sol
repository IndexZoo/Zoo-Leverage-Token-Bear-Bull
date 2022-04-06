pragma solidity =0.6.10;


import "../interfaces/IUniswapV2Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TransferHelper } from "@uniswap/lib/contracts/libraries/TransferHelper.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import {console} from "hardhat/console.sol";

interface IXERC20 {
    function decimals() external view returns (uint8);
}

contract UniswapV2Router02Mock is IUniswapV2Router {
    using TransferHelper for address;
    using SafeMath for uint256;
    mapping(address => mapping (address => uint256)) public paths;
    mapping(address => mapping (address => uint256)) public num;
    mapping(address => mapping (address => uint256)) public denom;
    mapping (address => uint256) public liquidity;

    constructor() public  {
    }

    function setPrice(address token0, address token1, uint256 price) public {
        // price is in decimals of token1
        uint256 c = 10**3;
        uint256 d0 = 10**uint256(IXERC20(token0).decimals());
        uint256 d1 = 10**uint256(IXERC20(token1).decimals());
        // paths[token1][token0] = d0.mul(d1).div(price);
        num[token0][token1] = price;
        denom[token0][token1] = d0;
        num[token1][token0] = d1;
        denom[token1][token0] = price ;
    }

    function setLiquidity (address _token0, uint256 _liquidity) public {

    }

    function factory() external override pure returns (address) {}
    function WETH() external override pure returns (address){}

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external override returns (uint amountA, uint amountB, uint liquidity){
        tokenA.safeTransferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).transferFrom(msg.sender, address(this), amountBDesired);
        uint256 dA = 10**uint256(IXERC20(tokenA).decimals());
        uint256 price = amountBDesired.mul(dA).div(amountADesired);
        setPrice(tokenA, tokenB, price);
    }
    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external override payable returns (uint amountToken, uint amountETH, uint liquidity){}
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint liquidity,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external override returns (uint amountA, uint amountB){}
    function removeLiquidityETH(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external override returns (uint amountToken, uint amountETH){}
    function removeLiquidityWithPermit(
        address tokenA,
        address tokenB,
        uint liquidity,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external override returns (uint amountA, uint amountB){}
    function removeLiquidityETHWithPermit(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline,
        bool approveMax, uint8 v, bytes32 r, bytes32 s
    ) external override returns (uint amountToken, uint amountETH){}
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external override returns (uint[] memory amounts){
        address token0 = path[0];
        address token1 = path[1];
        // uint256 amountOut = liquidity[token1].mul(amountIn).div(liquidity[token0]);
        uint256 amountOut = num[token0][token1].mul(amountIn).div(denom[token0][token1]);
        require(amountOut >= amountOutMin, "Insufficient Amount");
        token1.safeTransfer( to, amountOut);
        token0.safeTransferFrom(msg.sender, address(this), amountIn);
        amounts = new uint[] (2);
        amounts[0] = amountIn; 
        amounts[1] = amountOut; 
    }
    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external override returns (uint[] memory amounts){
        address token0 = path[0];
        address token1 = path[1];
        uint256 amountIn = num[token1][token0].mul(amountOut).div(denom[token1][token0]);
        require(amountIn <= amountInMax, "Insufficient Amount");
 
        IERC20(token1).transfer( to, amountOut);
        token0.safeTransferFrom(msg.sender, address(this), amountIn);
        amounts = new uint[] (2);
        amounts[0] = amountIn; 
        amounts[1] = amountOut; 
    }
    function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)
        external override
        payable
        returns (uint[] memory amounts){}
    function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline)
        external override
        returns (uint[] memory amounts){}
    function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
        external override
        returns (uint[] memory amounts){}
    function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline)
        external override
        payable
        returns (uint[] memory amounts){}

    function quote(uint amountA, uint reserveA, uint reserveB) external override pure returns (uint amountB){}
    function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut) external override pure returns (uint amountOut){}
    function getAmountIn(uint amountOut, uint reserveIn, uint reserveOut) external override pure returns (uint amountIn){}
    function getAmountsOut(uint amountIn, address[] calldata path) external override view returns (uint[] memory amounts){
        address token0 = path[0];
        address token1 = path[1];
        uint256 amountOut = num[token0][token1].mul(amountIn).div(denom[token0][token1]);

        amounts = new uint[] (2);
        amounts[0] = amountIn; 
        amounts[1] = amountOut;       
    }
    function getAmountsIn(uint amountOut, address[] calldata path) external override view returns (uint[] memory amounts){
        address token0 = path[0];
        address token1 = path[1];
        uint256 amountIn = num[token1][token0].mul(amountOut).div(denom[token1][token0]);
        amounts = new uint[] (2);
        amounts[0] = amountIn; 
        amounts[1] = amountOut; 
    }
}