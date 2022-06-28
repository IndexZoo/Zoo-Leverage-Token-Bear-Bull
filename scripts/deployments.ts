const DEPLOYMENTS =  {
    rinkeby: {
        Controller: "0xec406b67311BFa68C9cdEDf0e3B42f20f01907b2",
        IntegrationRegistry: "0x6F733d47300118A5Ed76df9F0d1D1Cd57eB49b73",
        SetTokenCreator: "0x7F1a2ABC727F4BB91400B85074f4d2CAC39C08a6",
        BasicIssuanceModule: "0x6D03f2A527DB98aa43cD28709925ffda0A60328A",
        TradeModule: "0x60f54C5b6deA71B6C130b0e5055a3B0d40dD8f77",
        StreamingFeeModule: "0x04cea21887b85c2d8151a713780Db5b0ec88D0ae",
        UniswapV2ExchangeAdapter: "0x8fddF898e3ab7CE0DD6E1fbe8b08fCbfBf08d8D5",
        WETH: "0xc778417E063141139Fce010982780140Aa0cD5Ab",
        DAI: "0xc7ad46e0b8a400bb3c915120d284aafba8fc4735",
        MATIC: "0xec23daeab1deeb3587eeb3453d4e95db128b0e62",
        USDT: "0x5cc0f03f549e2b261f76d5c938e304b3728a3b00",
        UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
        DeployedTokenset: "0x3522b8e9c3A89131C769FC3f2901beBB21331A61",
    },
    polygon: {
        controller: "0x52B6554bF4F57589172dc7aB08957fb52B1b9Bc6",
        Lev3xIssuanceModule:  "0x5A34Bd2505d71C23bC0A5b01A3fEB0cd1AA3F418",
        Lev3xAaveLeverageModule:  "0x92e73aF4d2dD8598546F4dEE8FCc165a6ACdd455"
    },
    mainnet: {
        UniswapV2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        SushiswapRouter: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
        WETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        MATIC: "0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0",
        USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        DAI: "0x6b175474e89094c44da98b954eedeac495271d0f"
    },
    polygon2: {
        integration: "0xFd826814Dca5fcB5D43721d755375F020Fe27FD1",
        Lev3xIssuanceModule:  "0x0789e4fc07966B29458FDDB740d9ecD10Df3B9C8",
        Lev3xAaveLeverageModule:  "0xa775109258Ae4cA917b9694c03ff79B620933355",
        controller: "0xB8E1eBF8874186b5E44CFAbf1eE2d9323D039112",
        setTokenCreator: "0x78b5989603c34F6fEbC9d03Cd7b798155514737c",
        aWmatic: "0x8dF3aad3a84da6b69A4DA8aeC3eA40d9091B2Ac4",
        wmatic: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        dai: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
        mtcx3: "0xcd15de9546390f5ee242601d425cf92b812c420d",
        sushi: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        adapter: "0x357788Fc40d7b6582C04e9D5a9C5Bf81fe794DA3",
        adapter_stale: "0xaA4f611d501622131F1D4983a7D39d3f273f9107"   // router adapter ERROR

    }
}

export default DEPLOYMENTS;