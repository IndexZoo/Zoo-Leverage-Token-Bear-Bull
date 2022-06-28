# Walkthroughs
## Issue & Leverage
### Setup
###
- Create a new SetToken `index` with aToken being component for the index, e.g. aWmatic for wmatic.
- Initialize the leverage related modules after having controller and rest of ecosystem already deployed. 
```javascript
await lev3xIssuanceModule .initialize(index.address, ether(0), ether(0), ether(0), deployer.address, ADDRESS_ZERO);
await lev3xAaveLeverageModule.initialize(index.address,  D.polygon2.wmatic, D.polygon2.dai);
```
- In order to initialize `Lev3xAaveLeverageModul` make sure you allow the index and register the issuance module in that order.
```javascript
await lev3xAaveLeverageModule.updateAllowedSetToken(index.address, true);
await lev3xAaveLeverageModule.initialize(index.address,  D.polygon2.wmatic, D.polygon2.dai);
await lev3xAaveLeverageModule.registerToModule(index.address, lev3xIssuanceModule.address);
```
### Issue
- Issue new 0.001 index
```typescript
await issueModule.issue("0xcd15de9546390f5ee242601d425cf92b812c420d", "1000000000000000", "0x55ec991D34569941a77e90b54Fcc3e687234FfCD", "1500000000000000")
```
- Balance of index is 0.001 as shown by wallet
![alt](./issue-1-index-in-wallet.png "balance shown by wallet of index")

- Interactions that took place to issue index as shown in polygonscan. Notice the interactions with Aave.
![alt](./issue-1-interactions%20with%20aave.png "")

### Leverage
