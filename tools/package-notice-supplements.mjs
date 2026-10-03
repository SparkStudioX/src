// Exact package-version reviews. Upstream text belongs only in the ignored
// cache and distribution, never in this source repository.
const family = (names, repository, revision, license, files) => names.map(name => [name, { repository, revision, license, files }]);
export const reviewedSupplements = new Map([
  ['Scriban/7.5.0', { repository: 'scriban/scriban', revision: 'b916a431461ec8a6dcd1d6819e304726308242d3', license: 'BSD-2-Clause',
    files: [['license.txt', '7423242b4ae72bccdf19a06cd3c20790df8519a164a08f37b31cb4a40034d827']] }],
  ['libplctag/1.5.2', { repository: 'libplctag/libplctag.NET', revision: '343d1b0edeb7fcbae5d56e81477af7b3dc5b05fa', license: 'MPL-2.0',
    files: [['LICENSE', '1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5']],
    sourceAvailability: ['https://github.com/libplctag/libplctag.NET/tree/343d1b0edeb7fcbae5d56e81477af7b3dc5b05fa'] }],
  ['libplctag.NativeImport/1.0.41', { repository: 'libplctag/libplctag.NET', revision: '6ba1b192553372e65fb10eb6a0f1fb577890bdb9', license: 'MPL-2.0',
    files: [['LICENSE', '1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5']],
    sourceAvailability: ['https://github.com/libplctag/libplctag.NET/tree/6ba1b192553372e65fb10eb6a0f1fb577890bdb9', 'https://github.com/libplctag/libplctag/tree/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258'] }],
  ['S7netplus/0.20.0', { repository: 'killnine/s7netplus', revision: 'f1ae0ea084e712b59e414de6aaee7d196244a239', license: 'MIT', licenseDeclarationAbsent: true,
    files: [['License.txt', '8b41113cbe0e258b882c1f2eccb36174ca96e02a7bf8f23ea0260b14b769ea8e']] }],
  ...family(['System.Reactive/6.1.0'], 'dotnet/reactive', 'f4da16f15a3cde97f178396ea6e3489cc893651f', 'MIT', [
    ['LICENSE', 'cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310'],
  ]),
  ...family(['System.ComponentModel.Composition/10.0.11', 'System.ServiceProcess.ServiceController/10.0.11'], 'dotnet/dotnet', 'e2f47b0110ed922f21a1522da67279133ce28f32', 'MIT', [
    ['src/runtime/LICENSE.TXT', 'cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310'],
    ['src/runtime/THIRD-PARTY-NOTICES.TXT', '66f1d4e44973185519bb4aa8a9718eb22fc7af2cc532e3ae9cfc4c127ee7fc54'],
  ]),
  ...family(['AWSSDK.S3/4.0.104', 'AWSSDK.Core/4.0.102.8'], 'aws/aws-sdk-net', 'f5257515bbd26d04376ee826d07ec80ea267c9b9', 'Apache-2.0', [
    ['License.txt', '192898453336a3f666e8138988cdda21ee7b858b1184e00c882c531df174d0d1'],
    ['Notice.txt', 'ebc5492b4c77f9c52a8d33d27588e69717a33440bcb9e2cc5a2652309a4ed20f'],
  ]),
  ...family(['SQLitePCLRaw.bundle_e_sqlite3/2.1.12', 'SQLitePCLRaw.core/2.1.12', 'SQLitePCLRaw.lib.e_sqlite3/2.1.12', 'SQLitePCLRaw.provider.e_sqlite3/2.1.12'], 'ericsink/SQLitePCL.raw', 'ca835d21508bff43121c65081035840ac5006c4c', 'Apache-2.0', [
    ['LICENSE.TXT', 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
    ['NOTICE.TXT', '485b276b3d2bfaa26df348e1e5c84df3648981e09b88531a6a53006f0705c24b'],
  ]),
  ...family(['Microsoft.Data.SqlClient/7.0.3', 'Microsoft.Data.SqlClient.Extensions.Abstractions/7.0.3', 'Microsoft.Data.SqlClient.Internal.Logging/7.0.3', 'Microsoft.SqlServer.Server/1.0.0'], 'dotnet/sqlclient', 'daadd381d1da478c8f13ea220ecb9a4a2ef7d076', 'MIT', [
    ['LICENSE', '9fa73cb72fb654d029c9214f0e3eec32c301a0c23be71b50fe3910e61553fa34'],
    ['NOTICE.txt', 'db4e07b72af7b58c5a6cd39762fe757e7db7f9af4e67e8d6ecc05731dd7ff66c'],
  ]),
  ...family(['Microsoft.Data.Sqlite/10.0.12', 'Microsoft.Data.Sqlite.Core/10.0.12'], 'dotnet/dotnet', '95017c711e6afc1085133d440e42b4bd78155701', 'MIT', [
    ['src/efcore/LICENSE.txt', 'ae48df11a335dc1a615f4f938b69cba73bcf4485c4f97af49b38efb0f216353b'],
  ]),
  ...family(['Microsoft.Extensions.Hosting.WindowsServices/10.0.9', 'System.ServiceProcess.ServiceController/10.0.9'], 'dotnet/dotnet', '901ca941248413c79832d2fdbd709da0c4386353', 'MIT', [
    ['src/runtime/LICENSE.TXT', 'cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310'],
    ['src/runtime/THIRD-PARTY-NOTICES.TXT', '66f1d4e44973185519bb4aa8a9718eb22fc7af2cc532e3ae9cfc4c127ee7fc54'],
  ]),
  ...family(['Microsoft.IdentityModel.Abstractions/8.16.0', 'Microsoft.IdentityModel.JsonWebTokens/8.16.0', 'Microsoft.IdentityModel.Logging/8.16.0', 'Microsoft.IdentityModel.Protocols/8.16.0', 'Microsoft.IdentityModel.Protocols.OpenIdConnect/8.16.0', 'Microsoft.IdentityModel.Tokens/8.16.0', 'System.IdentityModel.Tokens.Jwt/8.16.0'], 'AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet', 'f8172402e711c043a59bef81bba2609cf1fb9f46', 'MIT', [
    ['LICENSE.txt', 'cba03f5387b05405e56b688376421acae396136af4b5116738dc6e5160f87ddd'],
    ['NOTICE.html', 'd9f0289a2c38b4eedf5f22a045b6b37212d0989afb5f416a5f9ace59958136f7'],
    ['ThirdPartyNotice.txt', '8d53e3a82ef34420b78b856dc5199ebed5ad854fc586014526ac17224fbbbc5e'],
  ]),
]);

// These original license files were reviewed in the locked packages. A new
// package/version or changed license text requires a new explicit review.
const netLicense = ['LICENSE.TXT', 'd7a68596ab69b06f51ca278a6545148e4269a9381c26d597c13df5d88e08cf5b'];
export const reviewedBundledLicenses = new Map([
  ...['Beckhoff.TwinCAT.Ads', 'Beckhoff.TwinCAT.Ads.Abstractions', 'Beckhoff.TwinCAT.Ads.ConfigurationProviders', 'Beckhoff.TwinCAT.Ads.Server', 'Beckhoff.TwinCAT.Ads.TcpRouter'].map(name => [`${name}/7.0.317`, { license: 'MIT', file: 'License.md', sha256: '2c054dee8bb260c9dd57d4728041f96f182eb474f254a6f16c75e6aa02b05d6e' }]),
  ['BitFaster.Caching/2.6.0', { license: 'MIT', file: 'LICENSE', sha256: 'f3bf474c62109fbe7b81345419eff56bfd6e5b539accc877a9b840e2e7a5176b' }],
  ['Newtonsoft.Json/13.0.4', { license: 'MIT', file: 'LICENSE.md', sha256: 'b98a397897ff55f76cddc380041507a95a896b2946e0188703bf0496793d6516' }],
  ['Microsoft.Data.SqlClient.SNI.runtime/6.0.3', { license: 'LicenseRef-Microsoft-SqlClient-SNI', file: 'LICENSE.txt', sha256: '9335e8bad875dd7be4eebd55d2335eb6433d1cea61aadb3817af7807bef8932a' }],
  ...['Microsoft.Bcl.Cryptography/9.0.13', 'System.Configuration.ConfigurationManager/9.0.13', 'System.Security.Cryptography.Pkcs/9.0.13', 'System.Security.Cryptography.ProtectedData/9.0.13'].map(name => [name, { license: 'MIT', file: netLicense[0], sha256: netLicense[1] }]),
  ...['Client', 'Configuration', 'Core', 'Security.Certificates', 'Types'].map(name => [`OPCFoundation.NetStandard.Opc.Ua.${name}/1.5.378.176`, { license: 'MIT', file: 'LICENSE.txt', sha256: '3927c73bc0abbd9327364bcfdcbb7d8a7be50c05c2948fcfb49a45b165bda737' }]),
]);
