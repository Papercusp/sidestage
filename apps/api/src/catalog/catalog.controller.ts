import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { CATALOG_SOURCE, type CatalogQuery, type CatalogSource } from './catalog.types';

@Controller('catalog')
export class CatalogController {
  constructor(@Inject(CATALOG_SOURCE) private readonly catalog: CatalogSource) {}

  @Get()
  search(
    @Query('q') q?: string,
    @Query('type') productType?: string,
    @Query('availability') availability?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const query: CatalogQuery = {
      q,
      productType,
      availability: availability === 'in-stock' ? 'in-stock' : 'all',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    };
    return this.catalog.search(query);
  }

  @Get('types')
  types() {
    return this.catalog.productTypes();
  }

  @Get('variants/:id')
  async variant(@Param('id') id: string) {
    const found = await this.catalog.variant(id);
    if (!found) throw new NotFoundException(`Variant ${id} was not found`);
    return found;
  }
}
